/**
 * Host administration — the API half of the server console.
 *
 * Nothing in this file touches the host. Every route resolves to an operation
 * *id* which is forwarded to the agent over a Unix socket; the agent owns the
 * allowlist and decides whether to perform it. What lives here is the part
 * that has to live in the API: who is allowed to ask, whether a dangerous
 * operation was confirmed, and writing down that it happened.
 *
 * There is no endpoint that accepts a command. Searching this file for
 * `exec`, `spawn` or `shell` should find nothing, and that is the invariant
 * worth protecting when extending it.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hostname } from 'node:os';
import type { WebSocket } from 'ws';
import { one, query } from '../db/platform.js';
import { ApiError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { securityEvent } from '../lib/security-log.js';
import { logger } from '../logger.js';
import { env } from '../env.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { mfaRequired, verifyMfaCode } from './mfa.routes.js';
import {
  requireServerAdmin,
  isPlatformOperator,
  authenticatedRecently,
  liveGrant,
  createGrant,
  revokeGrants,
  beginOperation,
  finishOperation,
  openTerminalSession,
  closeTerminalSession,
  touchTerminalSession,
  recordCommand,
  completeCommand,
  expireStaleSessions,
  issueTerminalTicket,
  consumeTerminalTicket,
} from '../lib/server-admin.js';
import {
  agentReachable,
  agentConfigured,
  listAgentOperations,
  executeOperation,
  readOperation,
  streamOperation,
  openPty,
  type OperationDescriptor,
  type StreamFrame,
} from '../lib/agent-client.js';

/* ------------------------------------------------------ allowlist cache */

/**
 * The agent's allowlist, cached briefly.
 *
 * The API needs it to know which operations require confirmation, and it is
 * fixed at the agent's compile time — but caching it forever would mean an
 * agent upgrade needs an API restart to be understood. Thirty seconds is short
 * enough that nobody notices and long enough that a dashboard poll does not
 * round-trip for it every time.
 */
let operationCache: { at: number; operations: Map<string, OperationDescriptor> } | null = null;

async function allowlist(): Promise<Map<string, OperationDescriptor>> {
  if (operationCache && Date.now() - operationCache.at < 30_000) return operationCache.operations;
  const list = await listAgentOperations();
  const map = new Map(list.map((operation) => [operation.id, operation]));
  operationCache = { at: Date.now(), operations: map };
  return map;
}

/* ---------------------------------------------------------------- guard */

/**
 * Resolve an operation and enforce its confirmation requirement.
 *
 * The agent checks this independently — it has to, since it cannot trust that
 * a request came from this code — but checking here as well means the operator
 * gets a useful error before a privileged process is involved at all.
 */
async function guard(
  operationId: string,
  confirm: string | undefined,
): Promise<OperationDescriptor> {
  const operations = await allowlist();
  const operation = operations.get(operationId);

  if (!operation) {
    throw new ApiError(
      'NOT_FOUND',
      'That operation does not exist. GET /api/v1/admin/server/operations lists everything this server can do.',
    );
  }

  if (operation.danger && confirm !== operation.confirmPhrase) {
    throw new ApiError('VALIDATION_ERROR', `This operation needs confirmation. Type exactly: ${operation.confirmPhrase}`, {
      confirmPhrase: operation.confirmPhrase,
      summary: operation.summary,
    });
  }

  return operation;
}

/**
 * Run an operation with the full audit lifecycle around it.
 *
 * The record is written before the call and completed after, so an operation
 * that reboots the machine still leaves a row saying who asked for it.
 */
async function runAudited(
  req: FastifyRequest,
  operationId: string,
  args: Record<string, unknown>,
  confirm: string | undefined,
) {
  const operation = await guard(operationId, confirm);

  if (operation.danger) {
    securityEvent('HOST_DANGEROUS_OPERATION', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      userId: req.user?.id,
      detail: `${operation.id} ${JSON.stringify(args)}`,
    });
  }

  const record = await beginOperation(req, { operation: operation.id, args, danger: operation.danger });

  try {
    const response = await executeOperation({ operation: operation.id, args, confirm });

    await finishOperation(record, {
      status: response.ok ? 'succeeded' : 'failed',
      exitCode: response.exitCode,
      error: response.ok ? undefined : response.error?.message,
    });

    void audit(req, {
      action: `SERVER_${operation.id.toUpperCase()}`,
      resourceType: 'server',
      metadata: { args, ok: response.ok, exitCode: response.exitCode ?? null, danger: operation.danger },
    });

    return { operation, response };
  } catch (error) {
    await finishOperation(record, { status: 'failed', error: (error as Error).message });
    throw error;
  }
}

/* --------------------------------------------------------------- routes */

export default async function adminServerRoutes(app: FastifyInstance) {
  const operator = { preHandler: [app.requireUser, requireServerAdmin] };

  /* ================================================================ */
  /* Overview                                                          */
  /* ================================================================ */

  /**
   * Whether this installation is set up to manage its host at all.
   *
   * Answered without contacting the agent when no credential is configured, so
   * a developer running `pnpm dev` on a laptop gets a clear "not a server
   * install" rather than a timeout.
   */
  app.get('/admin/server/agent', operator, async () => {
    const reachable = await agentReachable();
    return {
      data: {
        configured: agentConfigured(),
        ...reachable,
        socket: env.KAIROS_AGENT_SOCKET,
        transport: env.KAIROS_AGENT_TCP_PORT ? `127.0.0.1:${env.KAIROS_AGENT_TCP_PORT}` : 'unix socket',
      },
      error: null,
    };
  });

  /** The allowlist, verbatim. Worth being able to read: it is the security boundary. */
  app.get('/admin/server/operations', operator, async () => {
    const operations = await listAgentOperations();
    return {
      data: {
        operations,
        note:
          'This is everything the server agent can do. There is no operation that runs an arbitrary command — ' +
          'the Ubuntu Terminal is a separate, time-limited grant.',
      },
      error: null,
    };
  });

  /**
   * The status page. Real values from the host, or an explicit failure.
   */
  app.get('/admin/server/status', operator, async () => {
    const status = await readOperation<unknown>('kairos_status');
    return { data: status, error: null };
  });

  app.get('/admin/server/doctor', operator, async () => {
    const result = await readOperation<unknown>('kairos_doctor');
    return { data: result, error: null };
  });

  app.get('/admin/server/system', operator, async () => {
    const system = await readOperation<unknown>('system_info');
    return { data: system, error: null };
  });

  app.get('/admin/server/identity', operator, async () => {
    const identity = await readOperation<{ serverId: string; publicKey: string; createdAt: string }>('server_identity');

    // Keep the platform's own row in step with the host's key, so the
    // dashboard and the CLI agree on which server this is.
    await query(
      `UPDATE server_identity SET public_key = $1, agent_last_seen_at = NOW() WHERE id = TRUE`,
      [identity.publicKey],
    ).catch(() => undefined);

    return { data: identity, error: null };
  });

  /* ================================================================ */
  /* Services                                                          */
  /* ================================================================ */

  app.get('/admin/server/services', operator, async () => {
    const services = await readOperation<unknown>('service_list');
    return { data: services, error: null };
  });

  const serviceAction = z.object({
    action: z.enum(['start', 'stop', 'restart']),
    confirm: z.string().max(200).optional(),
  });

  app.post('/admin/server/services/:service', operator, async (req) => {
    const { service } = req.params as { service: string };
    const body = serviceAction.parse(req.body ?? {});
    const operationId = `service_${body.action}`;

    const { operation, response } = await runAudited(req, operationId, { service }, body.confirm);

    if (!response.ok) {
      throw new ApiError('AGENT_OPERATION_FAILED', response.error?.message ?? `${operation.id} failed`, {
        output: response.text,
      });
    }

    return { data: { ...(response.data as object), output: response.text }, error: null };
  });

  /* ================================================================ */
  /* Database, storage, network, firewall — read paths                 */
  /* ================================================================ */

  const READ_ONLY: Record<string, string> = {
    database: 'database_status',
    redis: 'redis_status',
    nginx: 'nginx_status',
    storage: 'storage_status',
    network: 'network_status',
    ports: 'network_ports',
    firewall: 'firewall_status',
    'firewall-rules': 'firewall_rules',
    docker: 'docker_ps',
    'docker-stats': 'docker_stats',
    'docker-health': 'docker_health',
    processes: 'system_processes',
    disk: 'system_disk',
    dependencies: 'system_dependencies',
  };

  app.get('/admin/server/inspect/:what', operator, async (req) => {
    const { what } = req.params as { what: string };
    const operationId = READ_ONLY[what];
    if (!operationId) {
      throw new ApiError('NOT_FOUND', `Nothing to inspect called "${what}". Try: ${Object.keys(READ_ONLY).join(', ')}`);
    }
    const response = await executeOperation({ operation: operationId, timeoutMs: 180_000 });
    if (!response.ok) {
      throw new ApiError('AGENT_OPERATION_FAILED', response.error?.message ?? `${operationId} failed`);
    }
    return { data: { ...(response.data as object), output: response.text }, error: null };
  });

  /* ================================================================ */
  /* Firewall changes                                                  */
  /* ================================================================ */

  const firewallBody = z.object({
    confirm: z.string().max(200),
    source: z
      .string()
      .regex(/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/, 'Must be an IPv4 address or CIDR')
      .optional(),
  });

  const FIREWALL_ACTIONS: Record<string, string> = {
    baseline: 'firewall_apply_baseline',
    'open-https': 'firewall_open_https',
    'close-https': 'firewall_close_https',
    ssh: 'firewall_configure_ssh',
  };

  app.post('/admin/server/firewall/:action', operator, async (req) => {
    const { action } = req.params as { action: string };
    const operationId = FIREWALL_ACTIONS[action];
    if (!operationId) {
      throw new ApiError('NOT_FOUND', `No firewall action called "${action}". Try: ${Object.keys(FIREWALL_ACTIONS).join(', ')}`);
    }

    const body = firewallBody.parse(req.body ?? {});
    const args = operationId === 'firewall_configure_ssh' && body.source ? { source: body.source } : {};

    const { response } = await runAudited(req, operationId, args, body.confirm);
    if (!response.ok) {
      throw new ApiError('AGENT_OPERATION_FAILED', response.error?.message ?? 'Firewall change failed', {
        output: response.text,
      });
    }
    return { data: { ...(response.data as object), output: response.text }, error: null };
  });

  /* ================================================================ */
  /* Backups                                                           */
  /* ================================================================ */

  app.get('/admin/server/backups', operator, async () => {
    const backups = await readOperation<unknown>('backup_list');
    return { data: backups, error: null };
  });

  app.post('/admin/server/backups', operator, async (req) => {
    // Not dangerous, but slow: a dump of a large database can take minutes.
    const { response } = await runAudited(req, 'backup_create', {}, undefined);
    if (!response.ok) {
      throw new ApiError('AGENT_OPERATION_FAILED', response.error?.message ?? 'Backup failed', { output: response.text });
    }
    return { data: { ...(response.data as object), output: response.text }, error: null };
  });

  const backupIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'Malformed backup id');

  app.post('/admin/server/backups/:backup/verify', operator, async (req) => {
    const backup = backupIdSchema.parse((req.params as { backup: string }).backup);
    const { response } = await runAudited(req, 'backup_verify', { backup }, undefined);
    return { data: { ...(response.data as object), output: response.text, ok: response.ok }, error: null };
  });

  app.post('/admin/server/backups/:backup/restore', operator, async (req) => {
    const backup = backupIdSchema.parse((req.params as { backup: string }).backup);
    const body = z.object({ confirm: z.string() }).parse(req.body ?? {});

    const { response } = await runAudited(req, 'backup_restore', { backup }, body.confirm);
    if (!response.ok) {
      throw new ApiError('AGENT_OPERATION_FAILED', response.error?.message ?? 'Restore failed', { output: response.text });
    }
    return { data: { ...(response.data as object), output: response.text }, error: null };
  });

  /* ================================================================ */
  /* Power                                                             */
  /* ================================================================ */

  const POWER_ACTIONS: Record<string, string> = {
    reboot: 'server_reboot',
    shutdown: 'server_shutdown',
    cancel: 'server_power_cancel',
  };

  app.post('/admin/server/power/:action', operator, async (req) => {
    const { action } = req.params as { action: string };
    const operationId = POWER_ACTIONS[action];
    if (!operationId) throw new ApiError('NOT_FOUND', `No power action called "${action}"`);

    const body = z.object({ confirm: z.string().optional() }).parse(req.body ?? {});
    const { response } = await runAudited(req, operationId, {}, body.confirm);

    if (!response.ok) {
      throw new ApiError('AGENT_OPERATION_FAILED', response.error?.message ?? 'Power operation failed');
    }
    return { data: { ...(response.data as object), output: response.text }, error: null };
  });

  /* ================================================================ */
  /* Provisioning wizard                                               */
  /* ================================================================ */

  /**
   * The wizard's steps, in order.
   *
   * Each has a check that is safe to run at any time and, where it makes
   * sense, an apply that changes the machine. Steps with no apply are the ones
   * whose fix is a deliberate act outside the dashboard — installing Docker
   * from its own repository, for instance.
   */
  const SETUP_STEPS = [
    { step: 'system', title: 'System check', check: 'provision_check_system', apply: null, description: 'Confirm this host can run KAIROS.' },
    { step: 'dependencies', title: 'Dependencies', check: 'provision_check_dependencies', apply: 'provision_install_dependencies', description: 'Docker, PostgreSQL client, nftables, curl, OpenSSL.' },
    { step: 'storage', title: 'Storage', check: 'provision_check_storage', apply: 'provision_apply_storage', description: 'Create the KAIROS data directories.' },
    { step: 'firewall', title: 'Firewall', check: 'provision_check_firewall', apply: 'firewall_apply_baseline', description: 'Deny inbound by default; keep PostgreSQL and Redis private.' },
    { step: 'docker', title: 'Docker', check: 'provision_check_docker', apply: 'provision_apply_docker', description: 'Create the internal container network.' },
    { step: 'postgres', title: 'PostgreSQL', check: 'provision_check_postgres', apply: 'provision_write_postgres_conf', description: 'Settings derived from this machine\'s RAM and cores.' },
    { step: 'redis', title: 'Redis', check: 'provision_check_redis', apply: null, description: 'Internal-only cache and queue.' },
    { step: 'nginx', title: 'NGINX', check: 'provision_check_nginx', apply: null, description: 'TLS termination and reverse proxy.' },
    { step: 'backups', title: 'Backups', check: 'provision_check_backups', apply: null, description: 'One backup directory, shared by every writer.' },
    { step: 'health', title: 'Health check', check: 'provision_health_check', apply: null, description: 'Run every check against the running host.' },
  ] as const;

  app.get('/admin/server/setup', operator, async () => {
    const stored = await query<{ step: string; status: string; detail: string | null; updated_at: string }>(
      'SELECT step, status, detail, updated_at FROM server_setup_steps',
    ).catch(() => ({ rows: [] as { step: string; status: string; detail: string | null; updated_at: string }[] }));

    const byStep = new Map(stored.rows.map((row) => [row.step, row]));

    return {
      data: {
        steps: SETUP_STEPS.map((step) => ({
          ...step,
          recorded: byStep.get(step.step) ?? null,
        })),
        note:
          'Nothing here is trusted from the record alone. Run a step\'s check to see what the host reports right now.',
      },
      error: null,
    };
  });

  app.post('/admin/server/setup/:step/:mode', operator, async (req) => {
    const { step, mode } = req.params as { step: string; mode: string };
    const definition = SETUP_STEPS.find((entry) => entry.step === step);
    if (!definition) throw new ApiError('NOT_FOUND', `No setup step called "${step}"`);
    if (mode !== 'check' && mode !== 'apply') throw new ApiError('VALIDATION_ERROR', 'Mode must be check or apply');

    const operationId = mode === 'check' ? definition.check : definition.apply;
    if (!operationId) {
      throw new ApiError('VALIDATION_ERROR', `"${definition.title}" has no automatic apply — see its description.`);
    }

    const body = z.object({ confirm: z.string().max(200).optional() }).parse(req.body ?? {});

    await query(
      `INSERT INTO server_setup_steps (step, status, started_at, run_by)
       VALUES ($1,'running',NOW(),$2)
       ON CONFLICT (step) DO UPDATE SET status='running', started_at=NOW(), run_by=$2, updated_at=NOW()`,
      [step, req.user!.id],
    ).catch(() => undefined);

    const { response } = await runAudited(req, operationId, {}, body.confirm);

    const data = response.data as { ready?: boolean; healthy?: boolean; exists?: boolean } | null;
    // A check that runs successfully but reports "not ready" is not a completed
    // step. Deriving the status from what the host said, rather than from the
    // call succeeding, is the difference between a wizard and a progress bar.
    const satisfied =
      response.ok && (mode === 'apply' || data?.ready !== false) && data?.healthy !== false;

    await query(
      `UPDATE server_setup_steps
          SET status = $2, detail = $3, result = $4, updated_at = NOW()
        WHERE step = $1`,
      [
        step,
        response.ok ? (satisfied ? 'completed' : 'pending') : 'failed',
        (response.ok ? response.text : response.error?.message ?? 'failed')?.slice(0, 2_000) ?? null,
        JSON.stringify(response.data ?? {}),
      ],
    ).catch(() => undefined);

    return {
      data: {
        step,
        mode,
        ok: response.ok,
        satisfied,
        output: response.text,
        result: response.data,
        error: response.error?.message ?? null,
      },
      error: null,
    };
  });

  /* ================================================================ */
  /* Logs                                                              */
  /* ================================================================ */

  app.get('/admin/server/logs', operator, async () => {
    const sources = await readOperation<unknown>('logs_sources');
    return { data: sources, error: null };
  });

  const logQuery = z.object({
    lines: z.coerce.number().int().min(1).max(5_000).default(200),
    since: z.string().max(40).optional(),
  });

  app.get('/admin/server/logs/:source', operator, async (req) => {
    const { source } = req.params as { source: string };
    const params = logQuery.parse(req.query ?? {});

    const response = await executeOperation({
      operation: 'logs_read',
      args: { source, lines: params.lines, ...(params.since ? { since: params.since } : {}) },
      timeoutMs: 60_000,
    });

    if (!response.ok) throw new ApiError('AGENT_OPERATION_FAILED', response.error?.message ?? 'Could not read the log');
    return { data: { ...(response.data as object), output: response.text }, error: null };
  });

  /**
   * Live log tail, as Server-Sent Events.
   *
   * SSE rather than a WebSocket because this is one-directional and SSE
   * reconnects on its own. Note the heartbeat: without it, nginx's
   * proxy_read_timeout closes an idle stream after sixty seconds and the
   * operator watching a quiet service sees it "disconnect" for no reason.
   */
  app.get('/admin/server/logs/:source/stream', operator, async (req, reply) => {
    const { source } = req.params as { source: string };
    const lines = logQuery.parse(req.query ?? {}).lines;

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const send = (event: string, payload: unknown) => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    send('open', { source, lines });

    const handle = streamOperation({ operation: 'logs_follow', args: { source, lines: Math.min(lines, 1_000) } }, (frame) => {
      if (frame.type === 'out') send('line', { data: frame.data });
      else if (frame.type === 'error') send('error', { message: frame.message });
      else if (frame.type === 'done') send('done', { exitCode: frame.exitCode });
    });

    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(': keep-alive\n\n');
    }, 20_000);

    const stop = () => {
      clearInterval(heartbeat);
      handle.close();
      if (!reply.raw.writableEnded) reply.raw.end();
    };

    req.raw.on('close', stop);
    void handle.done.then(stop);

    // Fastify must not also try to send a response.
    return reply;
  });

  /* ================================================================ */
  /* Ubuntu Terminal grants                                            */
  /* ================================================================ */

  app.get('/admin/server/terminal/grant', operator, async (req) => {
    const [grant, recent, mfa] = await Promise.all([
      liveGrant(req.user!.id),
      authenticatedRecently(req.user!.id),
      mfaRequired(req.user!.id),
    ]);

    return {
      data: {
        active: grant !== null,
        grant: grant
          ? { id: grant.id, grantedAt: grant.granted_at, expiresAt: grant.expires_at, reason: grant.reason, mfaVerified: grant.mfa_verified }
          : null,
        ttlMinutes: env.KAIROS_UBUNTU_TERMINAL_TTL_MINUTES,
        requirements: {
          recentAuth: { satisfied: recent.ok, lastAuthAt: recent.lastAuthAt, withinMinutes: env.KAIROS_RECENT_AUTH_MINUTES },
          mfa: { enrolled: mfa, required: mfa },
        },
      },
      error: null,
    };
  });

  const grantBody = z.object({
    reason: z.string().min(4).max(200),
    confirm: z.literal('ENABLE UBUNTU TERMINAL'),
    mfaCode: z.string().regex(/^\d{6}$|^[A-Za-z0-9-]{8,32}$/).optional(),
  });

  /**
   * Turn on the Ubuntu Terminal.
   *
   * Four things are required and none of them is optional when the last one
   * applies: operator role, a recent sign-in, a typed confirmation, and a
   * second factor for accounts that have one enrolled. The grant then expires
   * on its own, because the failure mode to design against is not malice — it
   * is somebody enabling it on Tuesday and forgetting.
   */
  app.post('/admin/server/terminal/grant', operator, async (req) => {
    const body = grantBody.parse(req.body ?? {});
    const userId = req.user!.id;

    const recent = await authenticatedRecently(userId);
    if (!recent.ok) {
      throw new ApiError(
        'FORBIDDEN',
        `Sign in again before enabling the host terminal. This requires an authentication in the last ${env.KAIROS_RECENT_AUTH_MINUTES} minutes.`,
      );
    }

    const needsMfa = await mfaRequired(userId);
    let mfaVerified = false;

    if (needsMfa) {
      if (!body.mfaCode) {
        throw new ApiError('FORBIDDEN', 'Enter a code from your authenticator to enable the host terminal.', {
          mfaRequired: true,
        });
      }
      mfaVerified = await verifyMfaCode(userId, body.mfaCode);
      if (!mfaVerified) {
        securityEvent('AUTH_FAILURE', {
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          userId,
          detail: 'bad MFA code on ubuntu terminal grant',
        });
        throw new ApiError('INVALID_CREDENTIALS', 'That code is not right.');
      }
    }

    const grant = await createGrant(req, { userId, reason: body.reason, mfaVerified });

    return {
      data: {
        grant: { id: grant.id, expiresAt: grant.expires_at, reason: grant.reason, mfaVerified },
        expiresInMinutes: env.KAIROS_UBUNTU_TERMINAL_TTL_MINUTES,
        note:
          'Full shell access to the host is enabled for this account until the time above. Every session and every ' +
          'command is recorded. It turns itself off; you do not have to remember to.',
      },
      error: null,
    };
  });

  app.delete('/admin/server/terminal/grant', operator, async (req) => {
    const revoked = await revokeGrants(req, req.user!.id);
    return { data: { revoked }, error: null };
  });

  /* ================================================================ */
  /* Terminal sessions                                                 */
  /* ================================================================ */

  app.get('/admin/server/terminal/sessions', operator, async () => {
    await expireStaleSessions();

    const sessions = await query<Record<string, unknown>>(
      `SELECT s.id, s.mode, s.started_at, s.ended_at, s.status, s.ip_address, s.close_reason,
              u.email,
              (SELECT COUNT(*) FROM terminal_commands c WHERE c.session_id = s.id)::int AS command_count
         FROM terminal_sessions s
         JOIN users u ON u.id = s.user_id
        ORDER BY s.started_at DESC
        LIMIT 100`,
    );

    return { data: { sessions: sessions.rows }, error: null };
  });

  app.get('/admin/server/terminal/sessions/:id/commands', operator, async (req) => {
    const { id } = req.params as { id: string };
    const commands = await query<Record<string, unknown>>(
      `SELECT id, operation, command_display, started_at, completed_at, exit_code, status
         FROM terminal_commands WHERE session_id = $1 ORDER BY started_at ASC LIMIT 1000`,
      [id],
    );
    return {
      data: {
        commands: commands.rows,
        note: 'Command output is deliberately not stored — it would put whatever was on screen into this table forever.',
      },
      error: null,
    };
  });

  /** Recent privileged operations, whether typed or clicked. */
  app.get('/admin/server/operations/history', operator, async (req) => {
    const params = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query ?? {});
    const rows = await query<Record<string, unknown>>(
      `SELECT o.id, o.operation, o.arguments, o.danger, o.started_at, o.completed_at,
              o.status, o.exit_code, o.error, o.ip_address, u.email
         FROM server_operations o
         LEFT JOIN users u ON u.id = o.user_id
        ORDER BY o.started_at DESC
        LIMIT $1`,
      [params.limit],
    );
    return { data: { operations: rows.rows }, error: null };
  });

  /* ================================================================ */
  /* Terminal ticket                                                   */
  /* ================================================================ */

  const ticketBody = z.object({ mode: z.enum(['kairos_shell', 'ubuntu_terminal']) });

  /**
   * Exchange a session for a one-time ticket the WebSocket can present.
   *
   * The browser cannot set an Authorization header on a WebSocket, and putting
   * the access token in the query string would write a live credential into
   * the nginx access log. The ticket is random, lives sixty seconds, and is
   * redeemed once.
   */
  app.post('/admin/server/terminal/ticket', operator, async (req) => {
    const body = ticketBody.parse(req.body ?? {});

    if (body.mode === 'ubuntu_terminal') {
      const grant = await liveGrant(req.user!.id);
      if (!grant) {
        throw new ApiError(
          'FORBIDDEN',
          'The Ubuntu Terminal is not enabled for this account. Enable it first — it expires on its own.',
        );
      }
    }

    const ticket = await issueTerminalTicket({ userId: req.user!.id, email: req.user!.email, mode: body.mode });
    return { data: { ticket, expiresInSeconds: 60, mode: body.mode }, error: null };
  });

  /* ================================================================ */
  /* The terminal itself                                               */
  /* ================================================================ */

  await registerTerminalSocket(app);
}

/* ==================================================================== */
/* WebSocket terminal                                                    */
/* ==================================================================== */

interface ClientFrame {
  type?: string;
  line?: string;
  data?: string;
  confirm?: string;
  cols?: number;
  rows?: number;
  signal?: string;
}

/**
 * The terminal socket.
 *
 * Two modes over one connection type:
 *
 *   kairos_shell     each line is parsed by the agent into an operation id and
 *                    run through the allowlist. This is the default and needs
 *                    no grant.
 *   ubuntu_terminal  a real PTY on the host, behind a live grant. The API is a
 *                    pipe and interprets nothing.
 *
 * Authentication happens before the socket is useful: the ticket is redeemed,
 * operator status is re-checked against the database, and for the PTY the
 * grant is re-checked too. Nothing is taken from the client's claim about who
 * it is.
 */
async function registerTerminalSocket(app: FastifyInstance): Promise<void> {
  app.get('/admin/server/terminal', { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    const params = req.query as { ticket?: string; token?: string; cols?: string; rows?: string };

    const send = (payload: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
    };
    const fail = (code: number, message: string) => {
      send({ type: 'error', message });
      socket.close(code, message.slice(0, 120));
    };

    /* ---- authenticate ------------------------------------------- */

    let userId: string;
    let email: string;
    let mode: 'kairos_shell' | 'ubuntu_terminal';

    if (params.ticket) {
      const redeemed = await consumeTerminalTicket(params.ticket);
      if (!redeemed) return fail(4401, 'That terminal ticket is expired or already used.');
      userId = redeemed.userId;
      email = redeemed.email;
      mode = redeemed.mode;
    } else if (params.token) {
      // Supported for the CLI, which can hold a token safely and has no
      // browser to worry about. Still re-checked against the database below.
      try {
        const claims = await verifyAccessToken(params.token);
        const user = await one<{ id: string; email: string }>(
          'SELECT id, email FROM users WHERE id = $1 AND deleted_at IS NULL',
          [claims.sub],
        );
        if (!user) return fail(4401, 'That account no longer exists.');
        userId = user.id;
        email = user.email;
        mode = 'kairos_shell';
      } catch {
        return fail(4401, 'Invalid token.');
      }
    } else {
      return fail(4401, 'Provide a terminal ticket.');
    }

    // Re-check operator status here rather than trusting the ticket: the
    // ticket proves who you are, not what you are still allowed to do.
    if (!(await isPlatformOperator(userId, email))) {
      securityEvent('HOST_ADMIN_DENIED', {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        userId,
        detail: 'terminal socket',
      });
      return fail(4403, 'Server administration is limited to platform operators.');
    }

    let grantId: string | null = null;
    if (mode === 'ubuntu_terminal') {
      const grant = await liveGrant(userId);
      if (!grant) return fail(4403, 'The Ubuntu Terminal grant has expired. Enable it again.');
      grantId = grant.id;
    }

    /* ---- open the session --------------------------------------- */

    // req.user is what openTerminalSession reads for the audit columns; the
    // socket route has no preHandler to have set it.
    req.user = { id: userId, email, isPlatformAdmin: true };

    const serverId = (await one<{ server_id: string }>('SELECT server_id FROM server_identity WHERE id = TRUE').catch(
      () => null,
    ))?.server_id ?? hostname();

    const sessionId = await openTerminalSession(req, { userId, mode, serverId, grantId });

    logger.info({ sessionId, userId, mode }, 'terminal session opened');

    const heartbeat = setInterval(() => {
      void touchTerminalSession(sessionId);
    }, 30_000);

    let closed = false;
    const shutdown = (reason: string) => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      void closeTerminalSession(sessionId, reason);
      void audit(req, {
        action: 'TERMINAL_SESSION_CLOSED',
        resourceType: 'terminal_session',
        resourceId: sessionId,
        metadata: { mode, reason },
      });
      if (socket.readyState === socket.OPEN) socket.close(1000, reason.slice(0, 120));
    };

    socket.on('close', () => shutdown('socket closed'));
    socket.on('error', () => shutdown('socket error'));

    void audit(req, {
      action: 'TERMINAL_SESSION_OPENED',
      resourceType: 'terminal_session',
      resourceId: sessionId,
      metadata: { mode },
    });

    /* ================= KAIROS Shell ============================== */

    if (mode === 'kairos_shell') {
      send({
        type: 'ready',
        mode,
        sessionId,
        serverId,
        banner: [
          'KAIROS Shell',
          '',
          'A fixed set of operations against this host. Type `help` for the list.',
          'This is not bash — for that, enable the Ubuntu Terminal.',
          '',
        ].join('\r\n'),
      });

      let running = false;

      socket.on('message', (raw: Buffer) => {
        void (async () => {
          let frame: ClientFrame;
          try {
            frame = JSON.parse(raw.toString('utf8')) as ClientFrame;
          } catch {
            return send({ type: 'error', message: 'Frames must be JSON' });
          }

          if (frame.type === 'ping') return send({ type: 'pong' });
          if (frame.type !== 'command') return;

          const line = (frame.line ?? '').slice(0, 2_000);
          if (!line.trim()) return send({ type: 'done', exitCode: 0 });

          if (running) {
            return send({ type: 'output', data: '\r\nA command is already running in this session.\r\n' });
          }
          running = true;

          void touchTerminalSession(sessionId);
          const commandId = await recordCommand(sessionId, { operation: 'pending', display: line });

          let bytes = 0;
          let resolvedOperation = 'unparsed';
          let exitCode = 0;

          const handle = streamOperation(
            { operation: '', path: '/agent/shell', line, confirm: frame.confirm },
            (streamFrame: StreamFrame) => {
              switch (streamFrame.type) {
                case 'start':
                  resolvedOperation = streamFrame.operation ?? 'unparsed';
                  break;
                case 'out':
                  bytes += streamFrame.data.length;
                  // xterm.js needs CRLF; the agent emits LF like every other
                  // Unix program.
                  send({ type: 'output', data: streamFrame.data.replace(/(?<!\r)\n/g, '\r\n') });
                  break;
                case 'control':
                  send({ type: 'control', action: streamFrame.action });
                  break;
                case 'done':
                  exitCode = streamFrame.exitCode;
                  send({ type: 'done', exitCode: streamFrame.exitCode, operation: resolvedOperation });
                  break;
                case 'error':
                  exitCode = 1;
                  send({ type: 'output', data: `\r\n${streamFrame.message}\r\n` });
                  send({ type: 'done', exitCode: 1 });
                  break;
              }
            },
          );

          await handle.done;
          running = false;

          await query('UPDATE terminal_commands SET operation = $2 WHERE id = $1', [commandId, resolvedOperation]).catch(
            () => undefined,
          );
          await completeCommand(commandId, {
            status: exitCode === 0 ? 'succeeded' : exitCode === 126 || exitCode === 127 ? 'denied' : 'failed',
            exitCode,
            bytesOut: bytes,
          });
        })();
      });

      return;
    }

    /* ================= Ubuntu Terminal =========================== */

    const cols = Math.min(500, Math.max(20, Number(params.cols) || 80));
    const rows = Math.min(200, Math.max(5, Number(params.rows) || 24));

    securityEvent('HOST_TERMINAL_GRANTED', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      userId,
      detail: `ubuntu terminal session ${sessionId} opened`,
    });

    const commandId = await recordCommand(sessionId, {
      operation: 'ubuntu_terminal',
      // There is one "command" per PTY session. Individual keystrokes are not
      // recorded: capturing them would mean capturing passwords typed into
      // sudo, which is a worse outcome than the gap in the record.
      display: '(interactive shell)',
    });

    const pty = openPty({ cols, rows }, (frame) => {
      switch (frame.type) {
        case 'ready':
          send({
            type: 'ready',
            mode,
            sessionId,
            serverId,
            backend: frame.backend,
            resizable: frame.resizable,
            idleTimeoutMs: frame.idleTimeoutMs,
            maxLifetimeMs: frame.maxLifetimeMs,
            banner: frame.resizable
              ? ''
              : '\r\n\x1b[33m[kairos] node-pty is not installed, so window resizing will not reach the shell.\x1b[0m\r\n',
          });
          break;
        case 'out':
          send({ type: 'output', data: frame.data });
          break;
        case 'exit':
          send({ type: 'output', data: `\r\n\x1b[2m[kairos] ${frame.reason}\x1b[0m\r\n` });
          void completeCommand(commandId, { status: 'succeeded', exitCode: frame.code });
          shutdown(frame.reason);
          break;
      }
    });

    socket.on('message', (raw: Buffer) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(raw.toString('utf8')) as ClientFrame;
      } catch {
        return;
      }

      void touchTerminalSession(sessionId);

      switch (frame.type) {
        case 'input':
          if (typeof frame.data === 'string') pty.write(frame.data);
          break;
        case 'resize':
          if (typeof frame.cols === 'number' && typeof frame.rows === 'number') pty.resize(frame.cols, frame.rows);
          break;
        case 'signal':
          if (frame.signal === 'SIGINT' || frame.signal === 'SIGTERM' || frame.signal === 'SIGHUP') {
            pty.signal(frame.signal);
          }
          break;
        case 'ping':
          send({ type: 'pong' });
          break;
      }
    });

    socket.on('close', () => pty.close());
  });
}
