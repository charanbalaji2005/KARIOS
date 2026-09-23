'use client';

/**
 * Server overview.
 *
 * Everything on this page is read from the Ubuntu host through the agent. If a
 * reading is unavailable the page says so rather than showing a zero — a
 * dashboard that invents a CPU percentage is worse than one that admits it
 * cannot tell you, because the invented one gets believed.
 */

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Panel, Alert, Skeleton } from '@/components/ui';
import { StateBadge, Meter, Stat, AgentOffline, formatBytes, formatDuration, formatRelative } from '@/components/server-ui';
import type { ServerStatus, DoctorCheck, AgentStatus } from '@/lib/server';
import { sortServices } from '@/lib/server';

export default function ServerOverviewPage() {
  const agent = useQuery({
    queryKey: ['server-agent'],
    queryFn: () => api<AgentStatus>('/api/v1/admin/server/agent'),
    retry: false,
  });

  const status = useQuery({
    queryKey: ['server-status'],
    queryFn: () => api<ServerStatus>('/api/v1/admin/server/status'),
    refetchInterval: 10_000,
    retry: false,
    enabled: agent.data?.reachable === true,
  });

  const doctor = useQuery({
    queryKey: ['server-doctor'],
    queryFn: () => api<{ healthy: boolean; checks: DoctorCheck[] }>('/api/v1/admin/server/doctor'),
    refetchInterval: 60_000,
    retry: false,
    enabled: agent.data?.reachable === true,
  });

  if (agent.isLoading) return <Skeleton rows={8} />;

  if (!agent.data?.reachable) {
    return (
      <AgentOffline
        detail={agent.data?.detail ?? 'Could not ask the API whether the agent is running.'}
        configured={agent.data?.configured ?? false}
      />
    );
  }

  if (status.isLoading) return <Skeleton rows={8} />;

  if (status.error || !status.data) {
    return <Alert>Could not read host status: {(status.error as Error)?.message ?? 'unknown error'}</Alert>;
  }

  const data = status.data;
  const { system, postgres, redis, nginx, firewall, backups } = data;
  const failing = doctor.data?.checks.filter((check) => !check.ok) ?? [];
  const criticalExposure = data.exposure.filter((finding) => finding.severity === 'critical');

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl text-body">Overview</h1>
          <p className="mt-1 font-mono text-xs text-muted">
            {system.host.hostname} · {system.os?.prettyName ?? system.host.platform} · kernel {system.host.kernel} · up{' '}
            {formatDuration(system.host.uptimeSeconds)}
          </p>
        </div>
        <p className="font-mono text-xs text-muted">sampled {new Date(data.collectedAt).toLocaleTimeString()}</p>
      </header>

      {/* The findings that mean something is actually wrong, before the numbers. */}
      {criticalExposure.length > 0 ? (
        <Alert>
          <strong className="block">An internal service is reachable from the network.</strong>
          <ul className="mt-2 space-y-1">
            {criticalExposure.map((finding) => (
              <li key={`${finding.port}-${finding.address}`}>{finding.message}</li>
            ))}
          </ul>
          <Link href="/admin/server/firewall" className="mt-2 inline-block underline">
            Open the firewall page
          </Link>
        </Alert>
      ) : null}

      {!firewall.active ? (
        <Alert>
          The firewall is not denying inbound traffic by default. Until it is, every port this machine listens on is
          reachable from whatever network it is attached to.{' '}
          <Link href="/admin/server/firewall" className="underline">
            Apply the baseline ruleset
          </Link>
          .
        </Alert>
      ) : null}

      {system.disk.warning ? (
        <Alert>
          Storage is running low. PostgreSQL stops accepting writes when the volume fills, and uploads and backups fail
          before it does.
        </Alert>
      ) : null}

      {system.cpu.throttling ? (
        <Alert>
          The CPU is at {system.cpu.temperatureC}°C and is almost certainly throttling. Queries will look slow for reasons
          that have nothing to do with their plans. Check airflow before tuning indexes.
        </Alert>
      ) : null}

      {/* ---- vitals ------------------------------------------------ */}

      <section className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <Panel title="CPU">
          <Meter
            label="Utilisation"
            percent={system.cpu.usagePercent}
            detail={`${system.cpu.cores} cores · load ${system.cpu.loadAverage.join(' / ')}`}
          />
          <p className="mt-3 text-xs text-muted">{system.cpu.model}</p>
          <p className={`mt-1 font-mono text-xs ${system.cpu.throttling ? 'text-coral' : 'text-muted'}`}>
            {system.cpu.temperatureC !== null ? `${system.cpu.temperatureC}°C` : 'temperature unavailable'}
          </p>
        </Panel>

        <Panel title="Memory">
          <Meter
            label="In use"
            percent={system.memory.usedPercent}
            detail={`${formatBytes(system.memory.availableBytes)} available of ${formatBytes(system.memory.totalBytes)}`}
          />
          {system.memory.swapTotalBytes > 0 ? (
            <p className="mt-3 font-mono text-xs text-muted">
              swap: {formatBytes(system.memory.swapUsedBytes)} of {formatBytes(system.memory.swapTotalBytes)}
            </p>
          ) : (
            <p className="mt-3 font-mono text-xs text-muted">no swap configured</p>
          )}
        </Panel>

        <Panel title="Storage">
          {system.disk.data ? (
            <Meter
              label="Data volume"
              percent={system.disk.data.usedPercent}
              detail={`${formatBytes(system.disk.data.freeBytes)} free of ${formatBytes(system.disk.data.totalBytes)}`}
            />
          ) : (
            <p className="text-xs text-muted">The data volume at {system.dataRoot} is not readable.</p>
          )}
          {system.disk.root ? (
            <p className="mt-3 font-mono text-xs text-muted">
              root: {system.disk.root.usedPercent}% used · {formatBytes(system.disk.root.freeBytes)} free
            </p>
          ) : null}
        </Panel>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Network in"
          value={system.network.rxBytesPerSec !== null ? `${formatBytes(system.network.rxBytesPerSec)}/s` : '—'}
          hint={system.network.counters ? `${formatBytes(system.network.counters.rxBytes)} since boot` : 'counters unavailable'}
        />
        <Stat
          label="Network out"
          value={system.network.txBytesPerSec !== null ? `${formatBytes(system.network.txBytesPerSec)}/s` : '—'}
          hint={system.network.counters ? `${formatBytes(system.network.counters.txBytes)} since boot` : undefined}
        />
        <Stat
          label="Database size"
          value={postgres.sizeBytes !== null ? formatBytes(postgres.sizeBytes) : '—'}
          hint={postgres.databases !== null ? `${postgres.databases} databases` : postgres.detail ?? undefined}
        />
        <Stat
          label="Last backup"
          value={backups.latest ? formatRelative(backups.latest.createdAt) : 'never'}
          tone={backups.latest ? undefined : 'bad'}
          hint={backups.count > 0 ? `${backups.count} archives, ${formatBytes(backups.totalBytes)}` : 'this laptop is the only copy'}
        />
      </section>

      {/* ---- services ---------------------------------------------- */}

      <Panel
        title="Services"
        action={
          <Link href="/admin/server/services" className="font-mono text-xs text-muted hover:text-body">
            manage →
          </Link>
        }
      >
        <ul className="divide-y divide-edge">
          {sortServices(data.services)
            .filter((service) => service.state !== 'not_installed')
            .map((service) => (
              <li key={service.id} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
                <span className="text-sm text-body">{service.label}</span>
                <span className="flex items-center gap-3">
                  <span className="font-mono text-xs text-muted">{service.managedBy}</span>
                  <StateBadge state={service.state} />
                </span>
              </li>
            ))}
        </ul>
        {data.services.some((service) => service.conflict) ? (
          <div className="mt-4 space-y-2">
            {data.services
              .filter((service) => service.conflict)
              .map((service) => (
                <Alert key={service.id}>{service.conflict}</Alert>
              ))}
          </div>
        ) : null}
      </Panel>

      {/* ---- data stores ------------------------------------------- */}

      <section className="grid gap-6 lg:grid-cols-2">
        <Panel title="PostgreSQL">
          <div className="flex items-center gap-3">
            <StateBadge state={postgres.state} />
            <span className="font-mono text-xs text-muted">
              {postgres.accepting === null ? 'liveness unknown' : postgres.accepting ? 'accepting connections' : 'not accepting connections'}
            </span>
          </div>
          {postgres.version ? <p className="mt-3 font-mono text-xs text-muted">{postgres.version}</p> : null}
          {postgres.connections ? (
            <div className="mt-4">
              <Meter
                label="Connections"
                percent={
                  postgres.connections.max > 0
                    ? ((postgres.connections.active + postgres.connections.idle) / postgres.connections.max) * 100
                    : 0
                }
                detail={`${postgres.connections.active} active · ${postgres.connections.idle} idle · max ${postgres.connections.max}`}
              />
              <p className="mt-2 text-xs text-muted">Exhausting this rejects new connections outright.</p>
            </div>
          ) : postgres.detail ? (
            <p className="mt-3 text-xs text-muted">{postgres.detail}</p>
          ) : null}
        </Panel>

        <Panel title="Redis">
          <div className="flex items-center gap-3">
            <StateBadge state={redis.state} />
            <span className="font-mono text-xs text-muted">
              {redis.reachable === null ? 'reachability unknown' : redis.reachable ? 'responding to PING' : 'not responding'}
            </span>
          </div>
          {redis.reachable ? (
            <div className="mt-3 space-y-1 font-mono text-xs text-muted">
              {redis.version ? <p>version: {redis.version}</p> : null}
              {redis.usedMemoryBytes !== null ? <p>memory: {formatBytes(redis.usedMemoryBytes)}</p> : null}
              {redis.clients !== null ? <p>clients: {redis.clients}</p> : null}
              {redis.uptimeSeconds !== null ? <p>up {formatDuration(redis.uptimeSeconds)}</p> : null}
              {redis.keyspaceHits !== null && redis.keyspaceMisses !== null ? (
                <p>
                  hit rate:{' '}
                  {redis.keyspaceHits + redis.keyspaceMisses > 0
                    ? `${((redis.keyspaceHits / (redis.keyspaceHits + redis.keyspaceMisses)) * 100).toFixed(1)}%`
                    : 'no reads yet'}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-xs text-coral">
              {redis.detail ?? 'Rate limiting and realtime fan-out are degraded while Redis is down.'}
            </p>
          )}
        </Panel>
      </section>

      {/* ---- perimeter --------------------------------------------- */}

      <section className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="Perimeter"
          action={
            <Link href="/admin/server/firewall" className="font-mono text-xs text-muted hover:text-body">
              firewall →
            </Link>
          }
        >
          <dl className="space-y-2 font-mono text-xs">
            <div className="flex justify-between">
              <dt className="text-muted">firewall</dt>
              <dd>
                <StateBadge state={firewall.active ? 'active' : 'failed'} label={firewall.active ? 'ACTIVE' : 'INACTIVE'} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">backend</dt>
              <dd className="text-body">{firewall.backend}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">inbound default</dt>
              <dd className="text-body">{firewall.defaultPolicy ?? 'unknown'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">nginx config</dt>
              <dd className={nginx.configValid === false ? 'text-coral' : 'text-body'}>
                {nginx.configValid === null ? 'not checked' : nginx.configValid ? 'valid' : 'INVALID'}
              </dd>
            </div>
          </dl>

          <div className="mt-4">
            <p className="text-xs uppercase tracking-wide text-muted">Never exposed</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {firewall.blockedByDesign.map((entry) => (
                <li key={entry.port} className="rounded border border-edge bg-raised px-2 py-0.5 font-mono text-xs text-muted">
                  {entry.port} {entry.service}
                </li>
              ))}
            </ul>
          </div>
        </Panel>

        <Panel title="Health checks">
          {doctor.isLoading ? (
            <Skeleton rows={4} />
          ) : failing.length === 0 ? (
            <p className="text-sm text-mint">No problems found.</p>
          ) : (
            <ul className="space-y-3">
              {failing.map((check) => (
                <li key={check.name}>
                  <p className={`text-sm ${check.severity === 'critical' ? 'text-coral' : 'text-amber'}`}>{check.name}</p>
                  <p className="mt-0.5 text-xs text-muted">{check.detail}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </section>
    </div>
  );
}
