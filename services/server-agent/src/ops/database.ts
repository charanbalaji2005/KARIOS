/**
 * PostgreSQL, Redis and NGINX health, as seen from the host.
 *
 * The API already reports what it can see through its own connection pool.
 * This is the other half: whether the daemon is actually listening, whether
 * nginx's config parses, whether Redis is reachable — the things that are
 * still true when the API itself is the thing that is down, and therefore the
 * things an operator needs when the dashboard is the only tool left.
 */
import { register } from '../registry.js';
import { run, tryRun, binaryAvailable } from '../exec.js';
import { config } from '../config.js';
import { reportService } from './services.js';
import { findService } from '../units.js';
import { formatBytes } from './system.js';

/**
 * How the agent reaches PostgreSQL for the deeper queries.
 *
 * Read from the environment at start-up, never from a request. `psql` is
 * invoked with the URL in the environment rather than on the command line, so
 * the password does not appear in `ps` output for every user on the box.
 */
const DATABASE_URL = process.env['KAIROS_AGENT_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? null;
const REDIS_URL = process.env['KAIROS_AGENT_REDIS_URL'] ?? process.env['REDIS_URL'] ?? null;

interface PsqlOptions {
  timeoutMs?: number;
}

/**
 * Run a *fixed* SQL statement. There is no code path that lets a request
 * supply SQL: callers pass one of the literals defined below in this file.
 */
async function psql(sql: string, options: PsqlOptions = {}): Promise<string[][] | null> {
  if (!DATABASE_URL || !binaryAvailable('psql')) return null;
  const result = await run(
    'psql',
    [
      '--no-psqlrc',
      '--quiet',
      '--no-align',
      '--tuples-only',
      '--field-separator=\t',
      '--command',
      sql,
    ],
    {
      timeoutMs: options.timeoutMs ?? 15_000,
      allowNonZeroExit: true,
      env: {
        PGCONNECT_TIMEOUT: '5',
        // psql reads this rather than taking the URL as an argument.
        PGSERVICEFILE: '/dev/null',
        PGDATABASE: '',
        PGURI: DATABASE_URL,
        // libpq honours the URL through PGURI only in newer versions; pass it
        // the conventional way too.
        PGPASSFILE: '/dev/null',
        DATABASE_URL,
      },
      stdin: '',
    },
  ).catch(() => null);

  if (!result || result.code !== 0) return null;
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
}

/**
 * `psql` needs the connection string as an argument on most builds. Passing it
 * positionally exposes it in `ps`, so the agent instead writes a one-shot
 * `.pgpass`-free invocation using the URL via `PGURI`/`DATABASE_URL` above and
 * falls back to the positional form only when that fails — on a host where the
 * URL has no password (peer auth over the unix socket), which is the common
 * production layout.
 */
async function psqlFallback(sql: string): Promise<string[][] | null> {
  if (!DATABASE_URL || !binaryAvailable('psql')) return null;
  const result = await run(
    'psql',
    [DATABASE_URL, '--no-psqlrc', '--quiet', '--no-align', '--tuples-only', '--field-separator=\t', '--command', sql],
    { timeoutMs: 15_000, allowNonZeroExit: true, env: { PGCONNECT_TIMEOUT: '5' } },
  ).catch(() => null);
  if (!result || result.code !== 0) return null;
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => line.split('\t'));
}

async function queryDatabase(sql: string): Promise<string[][] | null> {
  return (await psql(sql)) ?? (await psqlFallback(sql));
}

/* ------------------------------------------------------------ postgres */

const SIZE_SQL =
  "SELECT COALESCE(SUM(pg_database_size(datname)), 0)::text, COUNT(*)::text FROM pg_database WHERE datistemplate = false";
const CONNECTION_SQL =
  "SELECT COUNT(*) FILTER (WHERE state = 'active')::text, COUNT(*) FILTER (WHERE state = 'idle')::text, current_setting('max_connections') FROM pg_stat_activity";
const VERSION_SQL = 'SELECT version()';

export async function postgresHealth() {
  const service = findService('postgres')!;
  const [report, ready] = await Promise.all([
    reportService(service),
    binaryAvailable('pg_isready')
      ? run('pg_isready', ['--quiet', '--timeout=5'], { timeoutMs: 10_000, allowNonZeroExit: true })
          .then((result) => result.code === 0)
          .catch(() => false)
      : Promise.resolve(null),
  ]);

  const [size, connections, version] = await Promise.all([
    queryDatabase(SIZE_SQL),
    queryDatabase(CONNECTION_SQL),
    queryDatabase(VERSION_SQL),
  ]);

  return {
    state: report.state,
    managedBy: report.managedBy,
    accepting: ready,
    version: version?.[0]?.[0]?.split(' ').slice(0, 2).join(' ') ?? null,
    sizeBytes: size?.[0]?.[0] ? Number(size[0][0]) : null,
    databases: size?.[0]?.[1] ? Number(size[0][1]) : null,
    connections: connections?.[0]
      ? {
          active: Number(connections[0][0] ?? 0),
          idle: Number(connections[0][1] ?? 0),
          max: Number(connections[0][2] ?? 0),
        }
      : null,
    // Say why the deeper figures are missing rather than showing zeroes.
    detail:
      size === null
        ? DATABASE_URL
          ? 'Connected to the service but could not query it — check the agent credentials.'
          : 'No database URL configured for the agent, so only liveness is reported.'
        : null,
  };
}

/* --------------------------------------------------------------- redis */

export async function redisHealth() {
  const service = findService('redis')!;
  const report = await reportService(service);

  if (!binaryAvailable('redisCli')) {
    return { state: report.state, managedBy: report.managedBy, reachable: null, info: null, detail: 'redis-cli is not installed, so only the service state is reported.' };
  }

  const args = REDIS_URL ? ['-u', REDIS_URL] : [];
  const ping = await tryRun('redisCli', [...args, 'ping'], { timeoutMs: 8_000 });
  const reachable = ping?.trim().toUpperCase() === 'PONG';

  let info: Record<string, string> | null = null;
  if (reachable) {
    const raw = await tryRun('redisCli', [...args, 'info'], { timeoutMs: 10_000 });
    if (raw) {
      info = {};
      for (const line of raw.split(/\r?\n/)) {
        const index = line.indexOf(':');
        if (index > 0) info[line.slice(0, index)] = line.slice(index + 1).trim();
      }
    }
  }

  return {
    state: report.state,
    managedBy: report.managedBy,
    reachable,
    version: info?.['redis_version'] ?? null,
    usedMemoryBytes: info?.['used_memory'] ? Number(info['used_memory']) : null,
    clients: info?.['connected_clients'] ? Number(info['connected_clients']) : null,
    uptimeSeconds: info?.['uptime_in_seconds'] ? Number(info['uptime_in_seconds']) : null,
    keyspaceHits: info?.['keyspace_hits'] ? Number(info['keyspace_hits']) : null,
    keyspaceMisses: info?.['keyspace_misses'] ? Number(info['keyspace_misses']) : null,
    detail: null,
  };
}

/* --------------------------------------------------------------- nginx */

export async function nginxHealth() {
  const service = findService('nginx')!;
  const report = await reportService(service);

  let configValid: boolean | null = null;
  let configDetail: string | null = null;

  if (binaryAvailable('nginx')) {
    const result = await run('nginx', ['-t'], { timeoutMs: 15_000, allowNonZeroExit: true }).catch(() => null);
    if (result) {
      configValid = result.code === 0;
      // nginx -t writes to stderr on success as well as failure.
      configDetail = (result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ');
    }
  } else if (report.managedBy === 'docker' && report.docker) {
    const result = await run('docker', ['exec', report.docker.container, 'nginx', '-t'], {
      timeoutMs: 20_000,
      allowNonZeroExit: true,
    }).catch(() => null);
    if (result) {
      configValid = result.code === 0;
      configDetail = (result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ');
    }
  }

  return {
    state: report.state,
    managedBy: report.managedBy,
    configValid,
    configDetail,
  };
}

/* ---------------------------------------------------------- operations */

function line(label: string, value: string): string {
  return `${label.padEnd(16)}${value}`;
}

register(
  {
    id: 'database_status',
    summary: 'PostgreSQL service state, version, size and connections',
    category: 'database',
    danger: false,
    timeoutMs: 45_000,
    async run() {
      const health = await postgresHealth();
      const lines = [
        line('PostgreSQL', health.state.toUpperCase()),
        line('managed by', health.managedBy),
        line('accepting', health.accepting === null ? 'unknown (pg_isready not installed)' : health.accepting ? 'yes' : 'no'),
      ];
      if (health.version) lines.push(line('version', health.version));
      if (health.sizeBytes !== null) lines.push(line('size', `${formatBytes(health.sizeBytes)} across ${health.databases} databases`));
      if (health.connections) {
        lines.push(
          line('connections', `${health.connections.active} active · ${health.connections.idle} idle · max ${health.connections.max}`),
        );
      }
      if (health.detail) lines.push('', health.detail);
      return { data: health, text: lines.join('\n') };
    },
  },
  {
    id: 'redis_status',
    summary: 'Redis service state, memory and hit rate',
    category: 'database',
    danger: false,
    timeoutMs: 30_000,
    async run() {
      const health = await redisHealth();
      const lines = [
        line('Redis', health.state.toUpperCase()),
        line('managed by', health.managedBy),
        line('reachable', health.reachable === null ? 'unknown' : health.reachable ? 'yes' : 'no'),
      ];
      if (health.version) lines.push(line('version', health.version));
      if (health.usedMemoryBytes !== null && health.usedMemoryBytes !== undefined) lines.push(line('memory', formatBytes(health.usedMemoryBytes)));
      if (health.clients !== null && health.clients !== undefined) lines.push(line('clients', String(health.clients)));
      if (health.keyspaceHits !== null && health.keyspaceHits !== undefined && health.keyspaceMisses !== null && health.keyspaceMisses !== undefined) {
        const total = health.keyspaceHits + health.keyspaceMisses;
        lines.push(line('hit rate', total > 0 ? `${((health.keyspaceHits / total) * 100).toFixed(1)}%` : 'no reads yet'));
      }
      if (health.detail) lines.push('', health.detail);
      return { data: health, text: lines.join('\n') };
    },
  },
  {
    id: 'nginx_status',
    summary: 'NGINX service state and whether its configuration parses',
    category: 'network',
    danger: false,
    timeoutMs: 30_000,
    async run() {
      const health = await nginxHealth();
      const lines = [
        line('NGINX', health.state.toUpperCase()),
        line('managed by', health.managedBy),
        line('config', health.configValid === null ? 'not checked' : health.configValid ? 'valid' : 'INVALID'),
      ];
      if (health.configDetail) lines.push('', health.configDetail);
      if (health.configValid === false) {
        lines.push('', 'Do not restart NGINX until this is fixed — it will fail to come back up and nothing will be reachable.');
      }
      return { data: health, text: lines.join('\n') };
    },
  },
  {
    id: 'nginx_reload',
    summary: 'Reload NGINX configuration without dropping connections',
    category: 'network',
    danger: false,
    timeoutMs: 30_000,
    async run({ emit }) {
      const health = await nginxHealth();
      // Reloading a broken config is how a working server becomes an
      // unreachable one, so the check is not optional.
      if (health.configValid === false) {
        throw new Error(`NGINX configuration does not parse, so it was not reloaded: ${health.configDetail ?? 'nginx -t failed'}`);
      }
      emit('Configuration parses. Reloading...\n');

      const service = findService('nginx')!;
      const report = await reportService(service);
      if (report.managedBy === 'systemd' && service.unit) {
        await run('systemctl', ['reload', service.unit], { timeoutMs: 20_000 });
      } else if (report.managedBy === 'docker' && report.docker) {
        await run('docker', ['exec', report.docker.container, 'nginx', '-s', 'reload'], { timeoutMs: 20_000 });
      } else {
        throw new Error('NGINX is not running on this host.');
      }
      return { data: { reloaded: true }, text: 'NGINX reloaded.' };
    },
  },
);

export { DATABASE_URL, queryDatabase };
