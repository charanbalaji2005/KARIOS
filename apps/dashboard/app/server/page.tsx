'use client';

/**
 * Server page.
 *
 * On a hosted platform this screen would be someone else's problem. Here the
 * laptop is the cloud, so disk pressure and CPU temperature are operational
 * facts the operator needs in front of them — not a footnote in Grafana.
 */

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api, formatBytes } from '@/lib/api';
import { Panel, Alert, Skeleton, StatusDot } from '@/components/ui';

interface DiskUsage {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

interface Metrics {
  host: { hostname: string; platform: string; release: string; uptimeSeconds: number; processUptimeSeconds: number };
  cpu: {
    cores: number;
    model: string;
    usagePercent: number;
    loadAverage: number[];
    temperatureC: number | null;
    throttling: boolean;
  };
  memory: { totalBytes: number; freeBytes: number; usedBytes: number; usedPercent: number; processRssBytes: number };
  disk: { data: DiskUsage | null; root: DiskUsage | null; warning: boolean };
  network: {
    counters: { rxBytes: number; txBytes: number } | null;
    throughput: { rxBytesPerSec: number; txBytesPerSec: number } | null;
  };
  postgres: {
    sizeBytes: number;
    connections: { active: number; idle: number; max: number };
    projects: { total: number; active: number };
    slowestQueries: { query: string; meanMs: number; calls: number }[];
  } | null;
  redis:
    | { connected: true; usedMemoryBytes: number; clients: number; keyspaceHits: number; keyspaceMisses: number; uptimeSeconds: number }
    | { connected: false };
  security: { window: string; topActions: { action: string; count: number }[] };
  collectedAt: string;
}

function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Colour tracks severity, but the number is always readable on its own. */
function severity(percent: number): string {
  if (percent >= 90) return 'text-coral';
  if (percent >= 75) return 'text-amber';
  return 'text-mint';
}

function Meter({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  const clamped = Math.min(100, Math.max(0, percent));
  const bar = clamped >= 90 ? 'bg-coral' : clamped >= 75 ? 'bg-amber' : 'bg-signal';
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
        <span className={`font-mono text-sm ${severity(clamped)}`}>{clamped.toFixed(1)}%</span>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised"
        role="meter"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className={`h-full ${bar} transition-[width] duration-500`} style={{ width: `${clamped}%` }} />
      </div>
      <p className="mt-1.5 font-mono text-xs text-muted">{detail}</p>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-edge bg-raised px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 font-mono text-lg text-body">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export default function ServerPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['server-metrics'],
    queryFn: () => api<Metrics>('/api/v1/server/metrics'),
    refetchInterval: 5000,
    // A stale reading is worse than an obviously old one on a health screen.
    refetchOnWindowFocus: true,
  });

  if (isLoading) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="text-xl text-body">Server</h1>
        <div className="mt-8">
          <Skeleton rows={6} />
        </div>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="text-xl text-body">Server</h1>
        <div className="mt-6">
          <Alert>
            Could not read server metrics. If the API is running inside a container, host statistics such as CPU
            temperature and network counters require <code className="font-mono">/proc</code> and{' '}
            <code className="font-mono">/sys</code> to be mounted.
          </Alert>
        </div>
      </main>
    );
  }

  const { cpu, memory, disk, network, postgres, redis, security, host } = data;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl text-body">Server</h1>
          <p className="mt-1 font-mono text-xs text-muted">
            {host.hostname} · {host.platform} {host.release} · up {formatDuration(host.uptimeSeconds)}
          </p>
        </div>
        <Link href="/projects" className="font-mono text-xs text-muted hover:text-body">
          ← all projects
        </Link>
      </header>

      {disk.warning ? (
        <div className="mt-6">
          <Alert>
            Storage is running low. PostgreSQL stops accepting writes when the volume fills, and uploads and backups
            fail before it does. Prune old backups or move the data volume to a larger disk.
          </Alert>
        </div>
      ) : null}

      {cpu.throttling ? (
        <div className="mt-4">
          <Alert>
            The CPU is at {cpu.temperatureC}°C and is almost certainly throttling. Queries will look slow for reasons
            that have nothing to do with their plans. Check airflow before tuning indexes.
          </Alert>
        </div>
      ) : null}

      <section className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <Panel title="CPU">
          <Meter
            label="Utilisation"
            percent={cpu.usagePercent}
            detail={`${cpu.cores} cores · load ${cpu.loadAverage.join(' / ')}`}
          />
          <p className="mt-3 text-xs text-muted">{cpu.model}</p>
          {cpu.temperatureC !== null ? (
            <p className={`mt-1 font-mono text-xs ${cpu.temperatureC > 85 ? 'text-coral' : 'text-muted'}`}>
              {cpu.temperatureC}°C
            </p>
          ) : (
            <p className="mt-1 font-mono text-xs text-muted">temperature unavailable</p>
          )}
        </Panel>

        <Panel title="Memory">
          <Meter
            label="In use"
            percent={memory.usedPercent}
            detail={`${formatBytes(memory.usedBytes)} of ${formatBytes(memory.totalBytes)}`}
          />
          <p className="mt-3 font-mono text-xs text-muted">API process: {formatBytes(memory.processRssBytes)}</p>
        </Panel>

        <Panel title="Storage">
          {disk.data ? (
            <Meter
              label="Data volume"
              percent={disk.data.usedPercent}
              detail={`${formatBytes(disk.data.freeBytes)} free of ${formatBytes(disk.data.totalBytes)}`}
            />
          ) : (
            <p className="text-xs text-muted">Data volume not readable</p>
          )}
          {disk.root ? (
            <p className="mt-3 font-mono text-xs text-muted">
              root: {disk.root.usedPercent}% used · {formatBytes(disk.root.freeBytes)} free
            </p>
          ) : null}
        </Panel>
      </section>

      <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Network in"
          value={network.throughput ? `${formatBytes(network.throughput.rxBytesPerSec)}/s` : '—'}
          hint={network.counters ? `${formatBytes(network.counters.rxBytes)} total` : 'counters unavailable'}
        />
        <Stat
          label="Network out"
          value={network.throughput ? `${formatBytes(network.throughput.txBytesPerSec)}/s` : '—'}
          hint={network.counters ? `${formatBytes(network.counters.txBytes)} total` : undefined}
        />
        <Stat
          label="Database size"
          value={postgres ? formatBytes(postgres.sizeBytes) : '—'}
          hint={postgres ? `${postgres.projects.active} active projects` : undefined}
        />
        <Stat
          label="API uptime"
          value={formatDuration(host.processUptimeSeconds)}
          hint={`sampled ${new Date(data.collectedAt).toLocaleTimeString()}`}
        />
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel title="PostgreSQL">
          {postgres ? (
            <>
              <div className="flex items-center gap-2">
                <StatusDot status="active" />
                <span className="font-mono text-xs text-muted">
                  {postgres.connections.active} active · {postgres.connections.idle} idle · max{' '}
                  {postgres.connections.max}
                </span>
              </div>
              <Meter
                label="Connection pool"
                percent={
                  postgres.connections.max > 0
                    ? ((postgres.connections.active + postgres.connections.idle) / postgres.connections.max) * 100
                    : 0
                }
                detail="Exhausting this rejects new connections outright."
              />
              {postgres.slowestQueries.length > 0 ? (
                <div className="mt-5">
                  <p className="text-xs uppercase tracking-wide text-muted">Slowest queries, last hour</p>
                  <ul className="mt-2 space-y-2">
                    {postgres.slowestQueries.map((q, i) => (
                      <li key={i} className="rounded border border-edge bg-raised px-3 py-2">
                        <code className="block truncate font-mono text-xs text-body">{q.query}</code>
                        <span className="font-mono text-xs text-muted">
                          {q.meanMs}ms mean · {q.calls} calls
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-muted">PostgreSQL statistics unavailable</p>
          )}
        </Panel>

        <Panel title="Redis">
          {redis.connected ? (
            <div className="space-y-2 font-mono text-xs text-muted">
              <div className="flex items-center gap-2">
                <StatusDot status="active" />
                <span>up {formatDuration(redis.uptimeSeconds)}</span>
              </div>
              <p>memory: {formatBytes(redis.usedMemoryBytes)}</p>
              <p>clients: {redis.clients}</p>
              <p>
                hit rate:{' '}
                {redis.keyspaceHits + redis.keyspaceMisses > 0
                  ? `${((redis.keyspaceHits / (redis.keyspaceHits + redis.keyspaceMisses)) * 100).toFixed(1)}%`
                  : 'no reads yet'}
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <StatusDot status="failed" />
              <span className="font-mono text-xs text-coral">
                Not reachable — rate limiting and realtime are degraded
              </span>
            </div>
          )}
        </Panel>
      </section>

      <section className="mt-6">
        <Panel title={`Audit activity, last ${security.window}`}>
          {security.topActions.length === 0 ? (
            <p className="text-xs text-muted">Nothing recorded yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {security.topActions.map((a) => (
                <li key={a.action} className="flex items-center justify-between font-mono text-xs">
                  <span className="text-muted">{a.action}</span>
                  <span className="text-body">{a.count}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-xs text-muted">
            Blocked requests and banned addresses are not shown here — they never reach the application. Check{' '}
            <code className="font-mono">fail2ban-client status</code> and the nginx access log for those.
          </p>
        </Panel>
      </section>
    </main>
  );
}
