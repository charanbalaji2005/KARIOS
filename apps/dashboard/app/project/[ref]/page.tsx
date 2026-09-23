'use client';

import { useQuery } from '@tanstack/react-query';
import { use, useState } from 'react';
import { api, formatBytes } from '@/lib/api';
import { Panel, Skeleton } from '@/components/ui';

interface QuotaEntry {
  resource: string;
  label: string;
  used: number;
  limit: number | null;
  percent: number | null;
  unlimited: boolean;
}

interface QuotaResponse {
  summary: QuotaEntry[];
  usage: { sampled_at: string };
  note: string;
}

const BYTE_RESOURCES = new Set(['database_bytes', 'storage_bytes', 'max_file_bytes']);

interface Usage {
  databaseBytes: number;
  tableCount: number;
  storageBytes: number;
  storageObjects: number;
  queriesLast24h: { hour: string; total: number; failed: number; avgMs: number }[];
}

export default function OverviewPage({ params }: { params: Promise<{ ref: string }> | { ref: string } }) {
  const { ref } = params instanceof Promise ? use(params) : params;
  const [revealPassword, setRevealPassword] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const usage = useQuery({ queryKey: ['usage', ref], queryFn: () => api<Usage>(`/api/v1/projects/${ref}/usage`) });
  const connection = useQuery({
    queryKey: ['connection', ref, revealPassword],
    queryFn: () => api<{ direct: string; psql: string; connectionString?: string }>(`/api/v1/projects/${ref}/connection${revealPassword ? '?reveal=true' : ''}`),
  });
  const quotas = useQuery({
    queryKey: ['quotas', ref],
    queryFn: () => api<QuotaResponse>(`/api/v1/projects/${ref}/quotas`),
  });

  const stats = usage.data
    ? [
        { label: 'Database size', value: formatBytes(usage.data.databaseBytes) },
        { label: 'Tables', value: String(usage.data.tableCount) },
        { label: 'Storage used', value: formatBytes(usage.data.storageBytes) },
        { label: 'Files', value: String(usage.data.storageObjects) },
      ]
    : [];

  const queries = usage.data?.queriesLast24h ?? [];
  const peak = Math.max(1, ...queries.map((q) => q.total));

  return (
    <main className="px-8 py-10">
      <h1 className="text-xl font-semibold text-body">Overview</h1>

      {usage.isLoading ? (
        <div className="mt-6"><Skeleton rows={2} /></div>
      ) : (
        <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-edge bg-edge sm:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="bg-panel px-4 py-5">
              <dt className="text-xs text-muted">{stat.label}</dt>
              <dd className="mt-1 font-mono text-lg text-body">{stat.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {quotas.data ? (
        <div className="mt-8">
          <Panel title="Resource limits">
            <ul className="space-y-4">
              {quotas.data.summary.map((entry) => {
                const format = BYTE_RESOURCES.has(entry.resource)
                  ? formatBytes
                  : (n: number) => String(n);
                const percent = entry.percent ?? 0;
                // Colour carries the warning, but the numbers are always
                // readable on their own — a colour-blind operator should not
                // have to guess which bar is the problem.
                const bar = percent >= 90 ? 'bg-coral' : percent >= 75 ? 'bg-amber' : 'bg-signal';
                return (
                  <li key={entry.resource}>
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs uppercase tracking-wide text-muted">{entry.label}</span>
                      <span className="font-mono text-xs text-body">
                        {entry.unlimited
                          ? `${format(entry.used)} · no limit`
                          : `${format(entry.used)} of ${format(entry.limit ?? 0)}`}
                      </span>
                    </div>
                    {entry.unlimited ? null : (
                      <div
                        className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised"
                        role="meter"
                        aria-valuenow={Math.round(percent)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={entry.label}
                      >
                        <div className={`h-full ${bar}`} style={{ width: `${Math.min(100, percent)}%` }} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="mt-5 text-xs text-muted">
              Database and storage figures come from the last sample
              {quotas.data.usage.sampled_at
                ? ` (${new Date(quotas.data.usage.sampled_at).toLocaleString()})`
                : ''}
              , not a live count. Only a platform operator can raise these limits.
            </p>
          </Panel>
        </div>
      ) : null}

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Panel title="Queries, last 24 hours">
          {queries.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted">No queries have run yet.</p>
          ) : (
            <div className="flex h-32 items-end gap-1" role="img" aria-label="Hourly query volume">
              {queries.map((point) => (
                <div
                  key={point.hour}
                  title={`${point.total} queries, ${point.failed} failed`}
                  style={{ height: `${Math.max((point.total / peak) * 100, 4)}%` }}
                  className={`flex-1 rounded-sm ${point.failed > 0 ? 'bg-amber' : 'bg-signal'}`}
                />
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Connect">
          {connection.isLoading ? (
            <Skeleton rows={2} />
          ) : (
            <div className="space-y-3 font-mono text-xs">
              <div>
                <div className="mb-1 flex items-center justify-between font-sans">
                  <span className="text-muted">Connection string</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (connection.data?.direct) {
                        navigator.clipboard.writeText(connection.data.direct);
                        setCopied('conn');
                        setTimeout(() => setCopied(null), 2000);
                      }
                    }}
                    className="text-xs text-primary hover:underline"
                  >
                    {copied === 'conn' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <code className="block break-all rounded border border-edge bg-raised p-2 text-body">
                  {connection.data?.direct}
                </code>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between font-sans">
                  <span className="text-muted">psql</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (connection.data?.psql) {
                        navigator.clipboard.writeText(connection.data.psql);
                        setCopied('psql');
                        setTimeout(() => setCopied(null), 2000);
                      }
                    }}
                    className="text-xs text-primary hover:underline"
                  >
                    {copied === 'psql' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <code className="block break-all rounded border border-edge bg-raised p-2 text-body">
                  {connection.data?.psql}
                </code>
              </div>
              <div className="flex items-center justify-between font-sans pt-1">
                <span className="text-muted text-xs">
                  {revealPassword ? 'Live password is shown above.' : 'The password is hidden.'}
                </span>
                <button
                  type="button"
                  onClick={() => setRevealPassword(!revealPassword)}
                  className="rounded border border-edge bg-raised px-2.5 py-1 text-xs font-medium text-body hover:bg-edge/40 transition-colors"
                >
                  {revealPassword ? 'Hide password' : 'Reveal password'}
                </button>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </main>
  );
}
