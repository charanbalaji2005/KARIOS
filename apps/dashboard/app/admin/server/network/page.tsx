'use client';

/**
 * Network.
 *
 * Interfaces, listening sockets, and the exposure check that matters most on
 * this product: the promise is that your API is reachable and your PostgreSQL
 * is not, and this page goes and looks rather than asserting it.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Panel, Alert, Skeleton } from '@/components/ui';
import { StateBadge, Stat, AgentOffline, formatBytes } from '@/components/server-ui';
import type { AgentStatus, ExposureFinding } from '@/lib/server';

interface ListeningSocket {
  protocol: string;
  address: string;
  port: number;
  process: string | null;
  exposed: boolean;
}

interface NetworkStatus {
  addresses: { iface: string; address: string; family: string; internal: boolean; mac: string }[];
  lan: { iface: string; address: string }[];
  gateway: string | null;
}

interface PortStatus {
  sockets: ListeningSocket[];
  findings: ExposureFinding[];
  secure: boolean;
}

interface NginxStatus {
  state: string;
  configValid: boolean | null;
  configDetail: string | null;
}

export default function NetworkPage() {
  const agent = useQuery({
    queryKey: ['server-agent'],
    queryFn: () => api<AgentStatus>('/api/v1/admin/server/agent'),
    retry: false,
  });

  const enabled = agent.data?.reachable === true;

  const network = useQuery({
    queryKey: ['server-network'],
    queryFn: () => api<NetworkStatus>('/api/v1/admin/server/inspect/network'),
    refetchInterval: 30_000,
    retry: false,
    enabled,
  });

  const ports = useQuery({
    queryKey: ['server-ports'],
    queryFn: () => api<PortStatus>('/api/v1/admin/server/inspect/ports'),
    refetchInterval: 30_000,
    retry: false,
    enabled,
  });

  const nginx = useQuery({
    queryKey: ['server-nginx'],
    queryFn: () => api<NginxStatus>('/api/v1/admin/server/inspect/nginx'),
    refetchInterval: 60_000,
    retry: false,
    enabled,
  });

  const status = useQuery({
    queryKey: ['server-status'],
    queryFn: () => api<{ system: { network: { rxBytesPerSec: number | null; txBytesPerSec: number | null } } }>(
      '/api/v1/admin/server/status',
    ),
    refetchInterval: 15_000,
    retry: false,
    enabled,
  });

  if (agent.isLoading) return <Skeleton rows={6} />;
  if (!agent.data?.reachable) {
    return <AgentOffline detail={agent.data?.detail ?? 'unknown'} configured={agent.data?.configured ?? false} />;
  }
  if (network.isLoading || ports.isLoading) return <Skeleton rows={8} />;

  const critical = ports.data?.findings.filter((finding) => finding.severity === 'critical') ?? [];
  const tcp = (ports.data?.sockets ?? []).filter((socket) => socket.protocol.startsWith('tcp')).sort((a, b) => a.port - b.port);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl text-body">Network</h1>
        <p className="mt-1 text-sm text-muted">
          How this machine is reachable, and what is listening on it.
        </p>
      </header>

      {critical.length > 0 ? (
        <Alert>
          <strong className="block">Internal services are bound to a public interface.</strong>
          <ul className="mt-2 space-y-1">
            {critical.map((finding) => (
              <li key={`${finding.port}-${finding.address}`}>{finding.message}</li>
            ))}
          </ul>
        </Alert>
      ) : ports.data?.secure ? (
        <div className="rounded-lg border border-edge bg-panel px-4 py-3">
          <div className="flex items-center gap-2">
            <StateBadge state="running" label="PRIVATE" />
            <p className="text-sm text-muted">
              PostgreSQL, Redis and the storage ports are bound to loopback only. Nothing off this machine can reach them
              directly.
            </p>
          </div>
        </div>
      ) : null}

      {nginx.data?.configValid === false ? (
        <Alert>
          The NGINX configuration does not parse: {nginx.data.configDetail}. Do not restart NGINX until this is fixed — it
          will fail to come back up and nothing will be reachable from outside.
        </Alert>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Inbound"
          value={
            status.data?.system.network.rxBytesPerSec !== null && status.data
              ? `${formatBytes(status.data.system.network.rxBytesPerSec ?? 0)}/s`
              : '—'
          }
        />
        <Stat
          label="Outbound"
          value={
            status.data?.system.network.txBytesPerSec !== null && status.data
              ? `${formatBytes(status.data.system.network.txBytesPerSec ?? 0)}/s`
              : '—'
          }
        />
        <Stat label="Gateway" value={network.data?.gateway ?? 'none'} hint="default route" />
        <Stat
          label="NGINX"
          value={nginx.data ? nginx.data.state.toUpperCase() : '—'}
          tone={nginx.data?.configValid === false ? 'bad' : undefined}
          hint={nginx.data?.configValid === null ? 'config not checked' : nginx.data?.configValid ? 'config valid' : 'config INVALID'}
        />
      </section>

      <Panel title="Reachable at">
        {network.data && network.data.lan.length > 0 ? (
          <ul className="space-y-1.5">
            {network.data.lan.map((entry) => (
              <li key={`${entry.iface}-${entry.address}`} className="flex items-center justify-between">
                <span className="font-mono text-xs text-muted">{entry.iface}</span>
                <span className="font-mono text-sm text-body">{entry.address}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">
            No non-loopback IPv4 addresses. This machine is not on a network, or every interface is a container bridge.
          </p>
        )}
        <p className="mt-3 text-xs text-muted">
          Docker bridges and veth pairs are excluded — they are not addresses another device can use.
        </p>
      </Panel>

      <Panel title="Listening sockets">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-edge text-xs uppercase tracking-wide text-muted">
              <th className="pb-2 font-normal">Port</th>
              <th className="pb-2 font-normal">Bound to</th>
              <th className="pb-2 font-normal">Process</th>
              <th className="pb-2 text-right font-normal">Reach</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {tcp.map((socket) => (
              <tr key={`${socket.protocol}-${socket.address}-${socket.port}`}>
                <td className="py-2 font-mono text-xs text-body">{socket.port}</td>
                <td className="py-2 font-mono text-xs text-muted">{socket.address}</td>
                <td className="py-2 font-mono text-xs text-muted">{socket.process ?? '—'}</td>
                <td className="py-2 text-right">
                  {socket.exposed ? (
                    <span className="font-mono text-xs text-amber">network</span>
                  ) : (
                    <span className="font-mono text-xs text-mint">loopback</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-muted">
          &quot;network&quot; means the socket is bound past loopback. Whether packets actually arrive is the firewall&apos;s
          job — the two are shown separately on purpose, because they disagree more often than anyone expects.
        </p>
      </Panel>

      <Panel title="Interfaces">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-edge text-xs uppercase tracking-wide text-muted">
              <th className="pb-2 font-normal">Interface</th>
              <th className="pb-2 font-normal">Address</th>
              <th className="pb-2 font-normal">Family</th>
              <th className="pb-2 text-right font-normal">MAC</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {(network.data?.addresses ?? []).map((entry) => (
              <tr key={`${entry.iface}-${entry.address}`} className={entry.internal ? 'opacity-50' : ''}>
                <td className="py-2 font-mono text-xs text-body">{entry.iface}</td>
                <td className="py-2 font-mono text-xs text-muted">{entry.address}</td>
                <td className="py-2 font-mono text-xs text-muted">{entry.family}</td>
                <td className="py-2 text-right font-mono text-xs text-muted">{entry.mac || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
