/**
 * Authorization and audit for host administration.
 *
 * Project RBAC does not apply here. Restarting PostgreSQL is not an action on
 * a project — it is an action on the machine every project lives on — so the
 * gate is platform operator, and a project owner has no more claim to it than
 * a viewer does.
 *
 * Two levels:
 *
 *   operator          may read host state and run non-destructive operations
 *   operator + grant  may open a real shell on the host
 *
 * Both are checked against the database on every request. Nothing is inferred
 * from a claim in the token, because a token minted before someone's operator
 * status was removed would otherwise keep working until it expired.
 */
import type { FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { one, query } from '../db/platform.js';
import { redis } from './redis.js';
import { sha256 } from './crypto.js';
import { env } from '../env.js';
import { ApiError } from './errors.js';
import { audit } from './audit.js';
import { securityEvent } from './security-log.js';
import { logger } from '../logger.js';

/* -------------------------------------------------------- operator gate */

/**
 * Platform operators, by the same rule the quota routes use: the
 * `is_platform_admin` column, or an address listed in PLATFORM_OPERATORS.
 *
 * The environment list exists so the first operator can exist before anyone
 * has been able to log in and grant it — a chicken-and-egg problem every
 * self-hosted product has.
 */
export async function isPlatformOperator(userId?: string, email?: string): Promise<boolean> {
  if (userId) {
    const row = await one<{ is_platform_admin: boolean }>(
      'SELECT is_platform_admin FROM users WHERE id = $1 AND deleted_at IS NULL',
      [userId],
    ).catch(() => null);
    if (row?.is_platform_admin) return true;
  }
  if (!email) return false;
  const operators = (process.env['PLATFORM_OPERATORS'] ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return operators.includes(email.toLowerCase());
}

/**
 * preHandler for every host-administration route.
 *
 * A refusal here is logged as a security event, not just returned. Someone
 * with a valid developer session probing `/admin/server/*` is worth knowing
 * about, and fail2ban tails that log.
 */
export async function requireServerAdmin(req: FastifyRequest): Promise<void> {
  if (!req.user) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue');

  if (!(await isPlatformOperator(req.user.id, req.user.email))) {
    securityEvent('HOST_ADMIN_DENIED', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      userId: req.user.id,
      detail: `${req.method} ${req.url}`,
    });
    throw new ApiError(
      'FORBIDDEN',
      'Server administration is limited to platform operators. Ask whoever runs this server.',
    );
  }
}

/* ----------------------------------------------------- recent authentication */

/**
 * Whether this account authenticated recently enough to be trusted with the
 * host shell.
 *
 * Measured from the newest live session rather than from token issuance: an
 * access token is refreshed silently every fifteen minutes, so its age proves
 * nothing about when a human last typed a password.
 */
export async function authenticatedRecently(userId: string): Promise<{ ok: boolean; lastAuthAt: string | null }> {
  const row = await one<{ created_at: string }>(
    `SELECT created_at FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1`,
    [userId],
  ).catch(() => null);

  if (!row) return { ok: false, lastAuthAt: null };

  const ageMinutes = (Date.now() - new Date(row.created_at).getTime()) / 60_000;
  return { ok: ageMinutes <= env.KAIROS_RECENT_AUTH_MINUTES, lastAuthAt: row.created_at };
}

/* ---------------------------------------------------- ubuntu terminal grant */

export interface ConsoleGrant {
  id: string;
  user_id: string;
  granted_at: string;
  expires_at: string;
  reason: string;
  mfa_verified: boolean;
}

/** The caller's live grant, or null. Expiry is evaluated in the database. */
export async function liveGrant(userId: string): Promise<ConsoleGrant | null> {
  return await one<ConsoleGrant>(
    `SELECT id, user_id, granted_at, expires_at, reason, mfa_verified
       FROM server_console_grants
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
      ORDER BY expires_at DESC
      LIMIT 1`,
    [userId],
  );
}

export async function createGrant(
  req: FastifyRequest,
  options: { userId: string; reason: string; mfaVerified: boolean },
): Promise<ConsoleGrant> {
  const expiresAt = new Date(Date.now() + env.KAIROS_UBUNTU_TERMINAL_TTL_MINUTES * 60_000);

  const grant = await one<ConsoleGrant>(
    `INSERT INTO server_console_grants (user_id, expires_at, reason, ip_address, user_agent, mfa_verified, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, user_id, granted_at, expires_at, reason, mfa_verified`,
    [
      options.userId,
      expiresAt,
      options.reason,
      req.ip,
      req.headers['user-agent'] ?? null,
      options.mfaVerified,
      String(req.id),
    ],
  );

  // Loud on purpose. This is the highest privilege the product grants, and it
  // should be visible in the security log without anyone going looking.
  securityEvent('HOST_TERMINAL_GRANTED', {
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    userId: options.userId,
    detail: `ubuntu terminal enabled until ${expiresAt.toISOString()} (mfa=${options.mfaVerified})`,
  });
  void audit(req, {
    action: 'UBUNTU_TERMINAL_ENABLED',
    resourceType: 'server',
    resourceId: grant!.id,
    metadata: { expiresAt: expiresAt.toISOString(), reason: options.reason, mfaVerified: options.mfaVerified },
  });

  return grant!;
}

export async function revokeGrants(req: FastifyRequest, userId: string): Promise<number> {
  const result = await query(
    `UPDATE server_console_grants SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [userId],
  );
  void audit(req, { action: 'UBUNTU_TERMINAL_DISABLED', resourceType: 'server', metadata: { revoked: result.rowCount } });
  return result.rowCount ?? 0;
}

/* -------------------------------------------------------- operation audit */

export interface OperationRecord {
  id: string;
}

/**
 * Record an operation *before* it runs.
 *
 * The row is written first and completed afterwards, so an operation that
 * takes the machine down — `server_reboot`, or a `service_stop` on the
 * database — still leaves evidence that it was attempted and by whom. An audit
 * trail written on completion records only the operations that did not break
 * anything, which is exactly the wrong half.
 */
export async function beginOperation(
  req: FastifyRequest,
  options: { operation: string; args?: Record<string, unknown>; danger: boolean },
): Promise<OperationRecord> {
  const row = await one<{ id: string }>(
    `INSERT INTO server_operations (user_id, operation, arguments, danger, ip_address, user_agent, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      req.user?.id ?? null,
      options.operation,
      JSON.stringify(options.args ?? {}),
      options.danger,
      req.ip,
      req.headers['user-agent'] ?? null,
      String(req.id),
    ],
  ).catch((error) => {
    logger.error({ err: error, operation: options.operation }, 'Failed to record server operation');
    return null;
  });

  return { id: row?.id ?? '' };
}

export async function finishOperation(
  record: OperationRecord,
  outcome: { status: 'succeeded' | 'failed' | 'denied' | 'timeout'; exitCode?: number; error?: string },
): Promise<void> {
  if (!record.id) return;
  await query(
    `UPDATE server_operations
        SET completed_at = NOW(), status = $2, exit_code = $3, error = $4
      WHERE id = $1`,
    [record.id, outcome.status, outcome.exitCode ?? null, outcome.error?.slice(0, 2_000) ?? null],
  ).catch((error) => logger.error({ err: error }, 'Failed to complete server operation record'));
}

/* ------------------------------------------------------ terminal sessions */

export interface TerminalSessionRow {
  id: string;
  mode: 'kairos_shell' | 'ubuntu_terminal';
  started_at: string;
  status: string;
}

export async function openTerminalSession(
  req: FastifyRequest,
  options: { userId: string; mode: 'kairos_shell' | 'ubuntu_terminal'; serverId: string; grantId?: string | null },
): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO terminal_sessions (user_id, role, server_id, mode, grant_id, ip_address, user_agent, request_id)
     VALUES ($1,'operator',$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      options.userId,
      options.serverId,
      options.mode,
      options.grantId ?? null,
      req.ip,
      req.headers['user-agent'] ?? null,
      String(req.id),
    ],
  );
  return row!.id;
}

export async function closeTerminalSession(sessionId: string, reason: string): Promise<void> {
  await query(
    `UPDATE terminal_sessions
        SET ended_at = NOW(), status = 'closed', close_reason = $2
      WHERE id = $1 AND status = 'open'`,
    [sessionId, reason.slice(0, 500)],
  ).catch((error) => logger.error({ err: error, sessionId }, 'Failed to close terminal session'));
}

export async function touchTerminalSession(sessionId: string): Promise<void> {
  await query('UPDATE terminal_sessions SET last_seen_at = NOW() WHERE id = $1', [sessionId]).catch(() => undefined);
}

/**
 * Record a command inside a session.
 *
 * `command_display` is what the operator typed and `operation` is what it
 * resolved to. Output is never stored: a session that runs `cat
 * /etc/kairos/agent.token` would otherwise write the agent credential into the
 * audit table permanently.
 */
export async function recordCommand(
  sessionId: string,
  options: { operation: string; display: string; args?: Record<string, unknown> },
): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO terminal_commands (session_id, operation, command_display, arguments)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [sessionId, options.operation, options.display.slice(0, 2_000), JSON.stringify(options.args ?? {})],
  ).catch(() => null);
  return row?.id ?? '';
}

export async function completeCommand(
  commandId: string,
  outcome: { status: 'succeeded' | 'failed' | 'denied' | 'timeout'; exitCode?: number; bytesOut?: number },
): Promise<void> {
  if (!commandId) return;
  await query(
    `UPDATE terminal_commands
        SET completed_at = NOW(), status = $2, exit_code = $3, bytes_out = $4
      WHERE id = $1`,
    [commandId, outcome.status, outcome.exitCode ?? null, outcome.bytesOut ?? 0],
  ).catch(() => undefined);
}

/**
 * Sessions the database still believes are open but whose owner disappeared.
 *
 * A browser that loses power never sends a close frame, so without this the
 * session list fills with rows that will never end and "who has a terminal
 * open right now" becomes unanswerable.
 */
export async function expireStaleSessions(olderThanMinutes = 30): Promise<number> {
  const result = await query(
    `UPDATE terminal_sessions
        SET status = 'expired', ended_at = NOW(), close_reason = 'no activity'
      WHERE status = 'open' AND last_seen_at < NOW() - ($1 || ' minutes')::interval`,
    [String(olderThanMinutes)],
  ).catch(() => ({ rowCount: 0 }));
  return result.rowCount ?? 0;
}

/* --------------------------------------------------------- ws tickets */

/**
 * One-time ticket for the terminal WebSocket.
 *
 * A browser cannot set an Authorization header on a WebSocket, so the
 * alternative is putting the access token in the query string — where it lands
 * in the nginx access log and stays valid for its full lifetime. A ticket is
 * random, lives sixty seconds, is redeemed exactly once, and is useless for
 * anything but opening one terminal.
 */
const TICKET_TTL_SECONDS = 60;

export interface TerminalTicket {
  userId: string;
  email: string;
  mode: 'kairos_shell' | 'ubuntu_terminal';
}

export async function issueTerminalTicket(payload: TerminalTicket): Promise<string> {
  const ticket = randomBytes(32).toString('base64url');
  await redis.setex(`terminal:ticket:${sha256(ticket)}`, TICKET_TTL_SECONDS, JSON.stringify(payload));
  return ticket;
}

export async function consumeTerminalTicket(ticket: string): Promise<TerminalTicket | null> {
  const key = `terminal:ticket:${sha256(ticket)}`;
  const raw = await redis.get(key).catch(() => null);
  if (!raw) return null;
  // Delete before use, so two sockets racing on one ticket cannot both win.
  await redis.del(key).catch(() => undefined);
  try {
    return JSON.parse(raw) as TerminalTicket;
  } catch {
    return null;
  }
}
