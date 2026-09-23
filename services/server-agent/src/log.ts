/**
 * Structured logging to stdout, which systemd captures into the journal.
 *
 * Deliberately not a logging library: this process runs as root and every
 * dependency it takes on is a dependency that runs as root.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env['KAIROS_AGENT_LOG_LEVEL'] as Level) ?? 'info'] ?? LEVELS.info;

/**
 * Keys whose values never reach the journal. The agent handles the token it
 * authenticates with and the arguments of operations that touch credentials;
 * neither belongs in a log file that is readable by anyone in adm.
 */
const REDACT = /^(token|password|secret|key|authorization|signature|passphrase)$/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => scrub(entry, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = REDACT.test(key) ? '[redacted]' : scrub(entry, depth + 1);
  }
  return output;
}

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = {
    time: new Date().toISOString(),
    level,
    component: 'server-agent',
    message,
    ...(fields ? (scrub(fields) as Record<string, unknown>) : {}),
  };
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(JSON.stringify(line) + '\n');
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => emit('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit('error', message, fields),
};
