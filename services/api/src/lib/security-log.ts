/**
 * Security event log.
 *
 * Fail2ban cannot read JSON, and it cannot read pino's pretty output either.
 * So security-relevant events get written twice: once through the normal
 * structured logger (for humans and for Grafana), and once as a fixed-shape
 * plain-text line that the jail regexes in infrastructure/fail2ban match.
 *
 * The line format is load-bearing. If you change it, change the filters in
 * infrastructure/fail2ban/filter.d/ in the same commit, and re-run
 *
 *     fail2ban-regex /var/log/kairos/security.log \
 *         /etc/fail2ban/filter.d/kairos-auth.conf
 *
 * to confirm the jail still matches. A filter that silently stops matching is
 * worse than no jail at all, because you will believe you are protected.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '../logger.js';
import { env } from '../env.js';

export type SecurityEvent =
  | 'AUTH_FAILURE'
  | 'AUTH_LOCKOUT'
  | 'TOKEN_REUSE'
  | 'INVALID_API_KEY'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'PATH_TRAVERSAL'
  | 'SQL_IDENTIFIER_REJECTED'
  | 'DESTRUCTIVE_STATEMENT_BLOCKED'
  /**
   * Host administration. These are new event names rather than reuses of
   * FORBIDDEN, so the existing jails keep matching exactly what they matched
   * before and these can be alerted on separately — someone probing
   * /admin/server/* with a valid developer session is a different signal from
   * a failed login.
   */
  | 'HOST_ADMIN_DENIED'
  | 'HOST_TERMINAL_GRANTED'
  | 'HOST_DANGEROUS_OPERATION';

interface SecurityContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
  userId?: string | undefined;
  projectRef?: string | undefined;
  detail?: string | undefined;
}

/** Keep values on one line and free of the delimiter, or the regex drifts. */
function scrub(value: string | undefined, fallback = '-'): string {
  if (!value) return fallback;
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 200).trim() || fallback;
}

let warnedAboutFile = false;

/**
 * Emit a security event.
 *
 * Deliberately not awaited by callers — an audit write must never be able to
 * delay or fail a request. Failures to write are logged once and swallowed.
 */
export function securityEvent(event: SecurityEvent, ctx: SecurityContext = {}): void {
  const ip = scrub(ctx.ip);
  const line =
    `${new Date().toISOString()} ` +
    `event=${event} ` +
    `ip=${ip} ` +
    `user=${scrub(ctx.userId)} ` +
    `project=${scrub(ctx.projectRef)} ` +
    `agent="${scrub(ctx.userAgent)}" ` +
    `detail="${scrub(ctx.detail)}"\n`;

  logger.warn({ event, ip, userId: ctx.userId, projectRef: ctx.projectRef, detail: ctx.detail }, 'security event');

  void (async () => {
    try {
      await mkdir(dirname(env.SECURITY_LOG_PATH), { recursive: true });
      await appendFile(env.SECURITY_LOG_PATH, line, 'utf8');
    } catch (error) {
      if (!warnedAboutFile) {
        warnedAboutFile = true;
        logger.error({ err: error, path: env.SECURITY_LOG_PATH }, 'security log is not writable — fail2ban jails will not fire');
      }
    }
  })();
}
