'use client';

/**
 * Storage.
 *
 * Usage for the KAIROS-owned directories and nothing else. There is no file
 * browser here and no path input anywhere in the stack — the agent resolves a
 * directory *id* against a fixed table, so there is nothing for a traversal
 * attempt to traverse.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Panel, Alert, Skeleton } from '@/components/ui';
import { Meter, Stat, AgentOffline, formatBytes } from '@/components/server-ui';
import type { AgentStatus, DiskUsage } from '@/lib/server';

interface DirectoryUsage {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  sizeBytes: number | null;
  mode: string | null;
}

interface StorageStatus {
  directories: DirectoryUsage[];
  disk: DiskUsage | null;
  accountedBytes: number;
  otherBytes: number | null;
  output: string;
}

/** Stable colours so a directory keeps its colour between refreshes. */
const SEGMENT_COLOR: Record<string, string> = {
  postgres: 'bg-signal',
  storage: 'bg-mint',
  backups: 'bg-amber',
  logs: 'bg-[#4FC4C4]',
  config: 'bg-[#B48EF2]',
  metrics: 'bg-[#7AD6D6]',
  redis: 'bg-[#E4685D]',
};

export default function StoragePage() {
  const agent = useQuery({
    queryKey: ['server-agent'],
    queryFn: () => api<AgentStatus>('/api/v1/admin/server/agent'),
    retry: false,
  });

  const storage = useQuery({
    queryKey: ['server-storage'],
    queryFn: () => api<StorageStatus>('/api/v1/admin/server/inspect/storage'),
    // `du` over a large storage tree is expensive, so this is not on a short
    // poll. The disk does not fill in thirty seconds.
    refetchInterval: 120_000,
    retry: false,
    enabled: agent.data?.reachable === true,
  });

  if (agent.isLoading) return <Skeleton rows={6} />;
  if (!agent.data?.reachable) {
    return <AgentOffline detail={agent.data?.detail ?? 'unknown'} configured={agent.data?.configured ?? false} />;
  }
  if (storage.isLoading) return <Skeleton rows={8} />;
  if (storage.error || !storage.data) {
    return <Alert>Could not read storage: {(storage.error as Error)?.message ?? 'unknown error'}</Alert>;
  }

  const { directories, disk, accountedBytes, otherBytes } = storage.data;
  const present = directories.filter((entry) => entry.exists && (entry.sizeBytes ?? 0) > 0);
  const missing = directories.filter((entry) => !entry.exists);
  const total = disk?.totalBytes ?? accountedBytes;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl text-body">Storage</h1>
        <p className="mt-1 text-sm text-muted">
          What KAIROS is keeping on this machine, and how much room is left for it.
        </p>
      </header>

      {disk && disk.usedPercent > 85 ? (
        <Alert>
          The data volume is {disk.usedPercent}% full. PostgreSQL refuses writes when it fills, and uploads and backups
          fail before that. Prune old backups or move the volume to a larger disk.
        </Alert>
      ) : null}

      {disk ? (
        <Panel title="Data volume">
          <Meter
            label={disk.path}
            percent={disk.usedPercent}
            detail={`${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)}`}
          />

          {/* Proportional bar, so "backups are eating the disk" is visible
              rather than arithmetic the reader has to do. */}
          <div className="mt-5 flex h-3 overflow-hidden rounded-full bg-raised" role="img" aria-label="Storage breakdown">
            {present.map((entry) => (
              <div
                key={entry.id}
                className={SEGMENT_COLOR[entry.id] ?? 'bg-muted'}
                style={{ width: `${Math.max(0.5, ((entry.sizeBytes ?? 0) / total) * 100)}%` }}
                title={`${entry.label}: ${formatBytes(entry.sizeBytes)}`}
              />
            ))}
            {otherBytes && otherBytes > 0 ? (
              <div
                className="bg-edge"
                style={{ width: `${Math.max(0.5, (otherBytes / total) * 100)}%` }}
                title={`Everything else on this volume: ${formatBytes(otherBytes)}`}
              />
            ) : null}
          </div>

          <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
            {present.map((entry) => (
              <li key={entry.id} className="flex items-center gap-2">
                <span className={`inline-block h-2 w-2 rounded-sm ${SEGMENT_COLOR[entry.id] ?? 'bg-muted'}`} aria-hidden />
                <span className="text-xs text-muted">{entry.label}</span>
                <span className="font-mono text-xs text-body">{formatBytes(entry.sizeBytes)}</span>
              </li>
            ))}
            {otherBytes && otherBytes > 0 ? (
              <li className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-sm bg-edge" aria-hidden />
                <span className="text-xs text-muted">Not KAIROS</span>
                <span className="font-mono text-xs text-body">{formatBytes(otherBytes)}</span>
              </li>
            ) : null}
          </ul>
        </Panel>
      ) : (
        <Alert>The data volume is not readable from the agent.</Alert>
      )}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="KAIROS total" value={formatBytes(accountedBytes)} hint="across every managed directory" />
        <Stat
          label="Free"
          value={disk ? formatBytes(disk.freeBytes) : '—'}
          tone={disk && disk.usedPercent > 90 ? 'bad' : disk && disk.usedPercent > 80 ? 'warn' : undefined}
        />
        <Stat label="Volume size" value={disk ? formatBytes(disk.totalBytes) : '—'} />
        <Stat label="Directories" value={`${directories.filter((entry) => entry.exists).length}/${directories.length}`} hint="created" />
      </section>

      <Panel title="Directories">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-edge text-xs uppercase tracking-wide text-muted">
              <th className="pb-2 font-normal">Contents</th>
              <th className="pb-2 font-normal">Path</th>
              <th className="pb-2 text-right font-normal">Size</th>
              <th className="pb-2 text-right font-normal">Mode</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {directories.map((entry) => (
              <tr key={entry.id}>
                <td className="py-2 text-sm text-body">{entry.label}</td>
                <td className="py-2 font-mono text-xs text-muted">{entry.path}</td>
                <td className="py-2 text-right font-mono text-xs text-body">
                  {!entry.exists ? (
                    <span className="text-amber">not created</span>
                  ) : entry.sizeBytes === null ? (
                    <span className="text-muted">unreadable</span>
                  ) : (
                    formatBytes(entry.sizeBytes)
                  )}
                </td>
                <td className="py-2 text-right font-mono text-xs">
                  {entry.mode ? (
                    <span className={/[2367]$/.test(entry.mode) ? 'text-coral' : 'text-muted'}>{entry.mode}</span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {missing.length > 0 ? (
          <p className="mt-4 text-xs text-muted">
            {missing.length} directories do not exist yet. The setup wizard&apos;s storage step creates them.
          </p>
        ) : null}

        <p className="mt-4 text-xs text-muted">
          Only these directories are visible to the dashboard. There is no operation that lists an arbitrary path, so the
          rest of the filesystem is not reachable from here at all.
        </p>
      </Panel>
    </div>
  );
}
