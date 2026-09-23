/**
 * Server metrics.
 *
 * The laptop is the cloud, so "how is the server doing" stops being an
 * abstract question and becomes "is the SSD full and is the CPU thermally
 * throttling". Everything here is measured, not estimated.
 *
 * Two endpoints:
 *   GET /api/v1/server/metrics    JSON for the dashboard
 *   GET /api/v1/server/prometheus text exposition for Prometheus
 *
 * Both require an authenticated platform user. Exposing host metrics publicly
 * tells an attacker exactly when you are under load and where the disk
 * pressure is, which is free reconnaissance.
 */
import type { FastifyInstance } from 'fastify';
import { readFile, statfs } from 'node:fs/promises';
import { cpus, totalmem, freemem, loadavg, uptime, hostname, platform, release } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { query, one } from '../db/platform.js';
import { redis } from '../lib/redis.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { metrics } from '../lib/metrics.js';
import { poolManager } from '../db/pool-manager.js';

/* ------------------------------------------------------------------ CPU */

interface CpuSample {
  idle: number;
  total: number;
}

function sampleCpu(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

/**
 * `os.cpus()` reports cumulative tick counts since boot, so a single read
 * gives you the average since the machine started — which is never the number
 * anyone wants. Two samples 200ms apart give the instantaneous figure.
 */
async function cpuUsagePercent(): Promise<number> {
  const first = sampleCpu();
  await delay(200);
  const second = sampleCpu();
  const idleDelta = second.idle - first.idle;
  const totalDelta = second.total - first.total;
  if (totalDelta <= 0) return 0;
  return Number(((1 - idleDelta / totalDelta) * 100).toFixed(1));
}

/* -------------------------------------------------------------- thermal */

/**
 * Laptops throttle. A server in a rack does not, so nobody reads this metric
 * on a normal deployment — here it is the difference between "slow query" and
 * "the CPU is at 96°C and has halved its clock".
 *
 * Linux only, and only when the thermal zone is readable. Returns null
 * everywhere else rather than guessing.
 */
async function cpuTemperatureC(): Promise<number | null> {
  if (platform() !== 'linux') return null;
  for (const zone of ['thermal_zone0', 'thermal_zone1', 'thermal_zone2']) {
    try {
      const raw = await readFile(`/sys/class/thermal/${zone}/temp`, 'utf8');
      const milli = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(milli) && milli > 0) {
        return Number((milli / 1000).toFixed(1));
      }
    } catch {
      // Zone absent or not readable from inside the container. Try the next.
    }
  }
  return null;
}

/* ----------------------------------------------------------------- disk */

interface DiskUsage {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

async function diskUsage(path: string): Promise<DiskUsage | null> {
  try {
    const stats = await statfs(path);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    const used = total - free;
    return {
      path,
      totalBytes: total,
      freeBytes: free,
      usedBytes: used,
      usedPercent: total > 0 ? Number(((used / total) * 100).toFixed(1)) : 0,
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- network */

interface NetworkCounters {
  rxBytes: number;
  txBytes: number;
}

async function networkCounters(): Promise<NetworkCounters | null> {
  if (platform() !== 'linux') return null;
  try {
    const raw = await readFile('/proc/net/dev', 'utf8');
    let rx = 0;
    let tx = 0;
    for (const line of raw.split('\n').slice(2)) {
      const [name, rest] = line.split(':');
      if (!name || !rest) continue;
      const iface = name.trim();
      // Loopback and Docker bridges are internal chatter, not real traffic.
      if (iface === 'lo' || iface.startsWith('docker') || iface.startsWith('br-') || iface.startsWith('veth')) continue;
      const fields = rest.trim().split(/\s+/);
      rx += Number(fields[0] ?? 0);
      tx += Number(fields[8] ?? 0);
    }
    return { rxBytes: rx, txBytes: tx };
  } catch {
    return null;
  }
}

/** Previous sample, so the endpoint can report a rate rather than a total. */
let lastNetwork: { counters: NetworkCounters; at: number } | null = null;

/* ------------------------------------------------------------- postgres */

async function postgresStats() {
  const size = await one<{ total: string }>(
    `SELECT COALESCE(SUM(pg_database_size(datname)), 0)::text AS total
       FROM pg_database WHERE datistemplate = false`,
  );
  const connections = await one<{ active: string; idle: string; max: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE state = 'active')::text AS active,
       COUNT(*) FILTER (WHERE state = 'idle')::text   AS idle,
       current_setting('max_connections')             AS max
     FROM pg_stat_activity`,
  );
  const projects = await one<{ total: string; active: string }>(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE status = 'active')::text AS active
       FROM projects WHERE deleted_at IS NULL`,
  );
  const slowest = await query<{ query: string; mean_ms: number; calls: number }>(
    `SELECT statement AS query,
            ROUND(AVG(duration_ms)::numeric, 1)::float8 AS mean_ms,
            COUNT(*)::int AS calls
       FROM query_logs
      WHERE created_at > NOW() - INTERVAL '1 hour'
      GROUP BY statement
      ORDER BY AVG(duration_ms) DESC
      LIMIT 5`,
  ).catch(() => ({ rows: [] as { query: string; mean_ms: number; calls: number }[] }));

  return {
    sizeBytes: Number(size?.total ?? 0),
    connections: {
      active: Number(connections?.active ?? 0),
      idle: Number(connections?.idle ?? 0),
      max: Number(connections?.max ?? 0),
    },
    projects: {
      total: Number(projects?.total ?? 0),
      active: Number(projects?.active ?? 0),
    },
    slowestQueries: slowest.rows.map((r) => ({
      query: r.query.slice(0, 160),
      meanMs: r.mean_ms,
      calls: r.calls,
    })),
  };
}

/* ---------------------------------------------------------------- redis */

async function redisStats() {
  try {
    const info = await redis.info();
    const map = new Map<string, string>();
    for (const line of info.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) map.set(line.slice(0, idx), line.slice(idx + 1).trim());
    }
    return {
      connected: true,
      usedMemoryBytes: Number(map.get('used_memory') ?? 0),
      peakMemoryBytes: Number(map.get('used_memory_peak') ?? 0),
      clients: Number(map.get('connected_clients') ?? 0),
      commandsProcessed: Number(map.get('total_commands_processed') ?? 0),
      keyspaceHits: Number(map.get('keyspace_hits') ?? 0),
      keyspaceMisses: Number(map.get('keyspace_misses') ?? 0),
      uptimeSeconds: Number(map.get('uptime_in_seconds') ?? 0),
    };
  } catch (error) {
    logger.warn({ err: error }, 'redis stats unavailable');
    return { connected: false };
  }
}

/* ------------------------------------------------------------- security */

async function securityStats() {
  const since = `NOW() - INTERVAL '24 hours'`;
  const rows = await query<{ action: string; count: string }>(
    `SELECT action, COUNT(*)::text AS count
       FROM audit_logs
      WHERE created_at > ${since}
      GROUP BY action
      ORDER BY COUNT(*) DESC
      LIMIT 10`,
  ).catch(() => ({ rows: [] as { action: string; count: string }[] }));

  return {
    window: '24h',
    topActions: rows.rows.map((r) => ({ action: r.action, count: Number(r.count) })),
  };
}

/* ---------------------------------------------------------------- route */

export default async function serverRoutes(app: FastifyInstance) {
  app.get('/server/metrics', { preHandler: [app.requireUser] }, async () => {
    const [cpuPercent, temperature, dataDisk, rootDisk, network, postgres, redisInfo, security] =
      await Promise.all([
        cpuUsagePercent(),
        cpuTemperatureC(),
        diskUsage(env.KAIROS_DATA_ROOT),
        diskUsage('/'),
        networkCounters(),
        postgresStats().catch(() => null),
        redisStats(),
        securityStats(),
      ]);

    // Turn cumulative byte counters into a throughput figure.
    let throughput: { rxBytesPerSec: number; txBytesPerSec: number } | null = null;
    if (network) {
      const now = Date.now();
      if (lastNetwork) {
        const seconds = (now - lastNetwork.at) / 1000;
        if (seconds > 0.5) {
          throughput = {
            rxBytesPerSec: Math.max(0, Math.round((network.rxBytes - lastNetwork.counters.rxBytes) / seconds)),
            txBytesPerSec: Math.max(0, Math.round((network.txBytes - lastNetwork.counters.txBytes) / seconds)),
          };
        }
      }
      lastNetwork = { counters: network, at: now };
    }

    const totalMemory = totalmem();
    const freeMemory = freemem();

    return {
      data: {
        host: {
          hostname: hostname(),
          platform: platform(),
          release: release(),
          uptimeSeconds: Math.round(uptime()),
          processUptimeSeconds: Math.round(process.uptime()),
        },
        cpu: {
          cores: cpus().length,
          model: cpus()[0]?.model ?? 'unknown',
          usagePercent: cpuPercent,
          loadAverage: loadavg().map((n) => Number(n.toFixed(2))),
          temperatureC: temperature,
          // A laptop above 85°C is throttling, whatever the CPU percentage says.
          throttling: temperature !== null && temperature > 85,
        },
        memory: {
          totalBytes: totalMemory,
          freeBytes: freeMemory,
          usedBytes: totalMemory - freeMemory,
          usedPercent: Number((((totalMemory - freeMemory) / totalMemory) * 100).toFixed(1)),
          processRssBytes: process.memoryUsage().rss,
        },
        disk: {
          data: dataDisk,
          root: rootDisk,
          // The laptop dies quietly when the disk fills: Postgres refuses
          // writes, uploads fail, and backups stop. Warn well before that.
          warning: (dataDisk?.usedPercent ?? 0) > 85 || (rootDisk?.usedPercent ?? 0) > 90,
        },
        network: { counters: network, throughput },
        postgres,
        redis: redisInfo,
        security,
        collectedAt: new Date().toISOString(),
      },
      error: null,
    };
  });

  /**
   * Prometheus text exposition. Scraped over the internal network only —
   * see infrastructure/monitoring/prometheus.yml.
   */
  app.get('/server/prometheus', { preHandler: [app.requireUser] }, async (_req, reply) => {
    const [cpuPercent, temperature, dataDisk] = await Promise.all([
      cpuUsagePercent(),
      cpuTemperatureC(),
      diskUsage(env.KAIROS_DATA_ROOT),
    ]);
    const totalMemory = totalmem();
    const freeMemory = freemem();

    const lines = [
      '# HELP kairos_cpu_usage_percent Instantaneous CPU utilisation.',
      '# TYPE kairos_cpu_usage_percent gauge',
      `kairos_cpu_usage_percent ${cpuPercent}`,
      '# HELP kairos_memory_used_bytes Resident memory in use on the host.',
      '# TYPE kairos_memory_used_bytes gauge',
      `kairos_memory_used_bytes ${totalMemory - freeMemory}`,
      '# HELP kairos_memory_total_bytes Total host memory.',
      '# TYPE kairos_memory_total_bytes gauge',
      `kairos_memory_total_bytes ${totalMemory}`,
      '# HELP kairos_process_uptime_seconds API process uptime.',
      '# TYPE kairos_process_uptime_seconds counter',
      `kairos_process_uptime_seconds ${Math.round(process.uptime())}`,
    ];

    if (dataDisk) {
      lines.push(
        '# HELP kairos_disk_used_bytes Bytes used on the data volume.',
        '# TYPE kairos_disk_used_bytes gauge',
        `kairos_disk_used_bytes ${dataDisk.usedBytes}`,
        '# HELP kairos_disk_total_bytes Size of the data volume.',
        '# TYPE kairos_disk_total_bytes gauge',
        `kairos_disk_total_bytes ${dataDisk.totalBytes}`,
      );
    }

    if (temperature !== null) {
      lines.push(
        '# HELP kairos_cpu_temperature_celsius CPU package temperature.',
        '# TYPE kairos_cpu_temperature_celsius gauge',
        `kairos_cpu_temperature_celsius ${temperature}`,
      );
    }

    /* ---- Connection pools ------------------------------------------- */
    const pools = poolManager.stats();
    lines.push(
      '# HELP kairos_pg_connections_allocated Connections allocated across project pools.',
      '# TYPE kairos_pg_connections_allocated gauge',
      `kairos_pg_connections_allocated ${pools.allocated}`,
      '# HELP kairos_pg_connection_budget Connections available to project pools.',
      '# TYPE kairos_pg_connection_budget gauge',
      `kairos_pg_connection_budget ${pools.projectBudget}`,
      '# HELP kairos_pg_pools Open project pools.',
      '# TYPE kairos_pg_pools gauge',
      `kairos_pg_pools ${pools.pools}`,
    );
    // Waiting clients are the number that actually predicts an outage: a pool
    // at capacity is fine until something is queued behind it.
    const waiting = pools.perPool.reduce((total, pool) => total + pool.waiting, 0);
    lines.push(
      '# HELP kairos_pg_clients_waiting Requests queued for a connection.',
      '# TYPE kairos_pg_clients_waiting gauge',
      `kairos_pg_clients_waiting ${waiting}`,
    );

    /* ---- Redis ------------------------------------------------------- */
    const redisInfo = await redisStats();
    if (redisInfo.connected) {
      const hits = redisInfo.keyspaceHits ?? 0;
      const misses = redisInfo.keyspaceMisses ?? 0;
      const total = hits + misses;
      lines.push(
        '# HELP kairos_redis_memory_bytes Redis memory in use.',
        '# TYPE kairos_redis_memory_bytes gauge',
        `kairos_redis_memory_bytes ${redisInfo.usedMemoryBytes}`,
        '# HELP kairos_redis_hit_ratio Keyspace hit ratio, 0 to 1.',
        '# TYPE kairos_redis_hit_ratio gauge',
        `kairos_redis_hit_ratio ${total > 0 ? (hits / total).toFixed(4) : 0}`,
        '# HELP kairos_redis_clients Connected clients.',
        '# TYPE kairos_redis_clients gauge',
        `kairos_redis_clients ${redisInfo.clients}`,
      );
    }

    /* ---- Platform counts --------------------------------------------- */
    const counts = await one<{ projects: string; violations: string; unverified: string; queued: string }>(
      `SELECT
         (SELECT COUNT(*) FROM projects WHERE deleted_at IS NULL AND status = 'active')::text AS projects,
         (SELECT COUNT(*) FROM quota_violations WHERE created_at > NOW() - INTERVAL '1 hour')::text AS violations,
         (SELECT COUNT(*) FROM database_backups WHERE status = 'completed' AND verified_at IS NULL)::text AS unverified,
         (SELECT COUNT(*) FROM webhook_deliveries WHERE NOT succeeded AND created_at > NOW() - INTERVAL '1 hour')::text AS queued`,
    ).catch(() => null);

    if (counts) {
      lines.push(
        '# HELP kairos_projects_active Active projects.',
        '# TYPE kairos_projects_active gauge',
        `kairos_projects_active ${counts.projects}`,
        '# HELP kairos_quota_violations_total Quota refusals in the last hour.',
        '# TYPE kairos_quota_violations_total gauge',
        `kairos_quota_violations_total ${counts.violations}`,
        '# HELP kairos_backups_unverified Completed backups that were never verified.',
        '# TYPE kairos_backups_unverified gauge',
        `kairos_backups_unverified ${counts.unverified}`,
        '# HELP kairos_webhook_failures_total Failed webhook deliveries in the last hour.',
        '# TYPE kairos_webhook_failures_total gauge',
        `kairos_webhook_failures_total ${counts.queued}`,
      );
    }

    /* ---- Request histograms ------------------------------------------ */
    // Everything the observability plugin has recorded: request counts,
    // errors, and per-route duration buckets that Prometheus can turn into
    // p50/p95/p99 with histogram_quantile.
    const rendered = metrics.render();
    if (rendered) lines.push(rendered);

    return reply.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n');
  });

  /**
   * Per-endpoint latency, for the dashboard.
   *
   * Quantiles come from the same histograms Prometheus scrapes, so the two
   * never disagree — which they would if this computed them a second way.
   */
  app.get('/server/latency', { preHandler: [app.requireUser] }, async () => {
    const snapshots = metrics
      .histogramSnapshots()
      .filter((entry) => entry.name === 'kairos_http_request_duration_seconds' && entry.snapshot.count > 0)
      .map((entry) => ({
        route: entry.labels['route'] ?? 'unknown',
        method: entry.labels['method'] ?? 'GET',
        requests: entry.snapshot.count,
        p50: entry.snapshot.p50,
        p95: entry.snapshot.p95,
        p99: entry.snapshot.p99,
        max: entry.snapshot.max,
        meanMs: Number((entry.snapshot.sum / entry.snapshot.count).toFixed(2)),
      }))
      .sort((a, b) => b.p95 - a.p95);

    return {
      data: {
        endpoints: snapshots,
        note:
          'Quantiles are interpolated from histogram buckets, so p99 is approximate — good enough to alert on, ' +
          'not precise enough to chase a single slow request. Use the query log for that.',
      },
      error: null,
    };
  });
}
