'use client';

/**
 * Server console shell.
 *
 * A normal developer-tool layout — sidebar, content — and deliberately *not* a
 * terminal-themed admin panel. The terminal is one page among eleven; making
 * the whole console look like a shell would make the parts that are not a
 * shell harder to read for no benefit.
 *
 * The header carries live host vitals, because on this product they are the
 * context for everything else on the page: a slow query and a 96°C CPU are the
 * same story, and you only notice that if both are on screen.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { StateBadge } from '@/components/server-ui';

const NAV = [
  { href: '/admin/server', label: 'Overview', exact: true },
  { href: '/admin/server/setup', label: 'Setup' },
  { href: '/admin/server/terminal', label: 'Terminal' },
  { href: '/admin/server/services', label: 'Services' },
  { href: '/admin/server/logs', label: 'Logs' },
  { href: '/admin/server/storage', label: 'Storage' },
  { href: '/admin/server/network', label: 'Network' },
  { href: '/admin/server/firewall', label: 'Firewall' },
  { href: '/admin/server/backups', label: 'Backups' },
  { href: '/admin/server/connections', label: 'Connections' },
  { href: '/admin/server/settings', label: 'Settings' },
];

interface Vitals {
  online: boolean;
  system: {
    host: { hostname: string; uptimeSeconds: number };
    os: { prettyName: string } | null;
    cpu: { usagePercent: number; temperatureC: number | null; throttling: boolean };
    memory: { usedPercent: number };
    disk: { data: { usedPercent: number } | null; warning: boolean };
  };
  firewall: { active: boolean };
}

function Vital({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <span className="whitespace-nowrap font-mono text-xs">
      <span className="text-muted">{label} </span>
      <span className={alert ? 'text-coral' : 'text-body'}>{value}</span>
    </span>
  );
}

export default function ServerLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  /**
   * Ten seconds, not one. Each poll makes the agent sample CPU over 200ms and
   * shell out to systemd and Docker for every service; polling this hard
   * enough to be "live" would make the dashboard the biggest load on the
   * machine it is monitoring.
   */
  const { data, isError } = useQuery({
    queryKey: ['server-vitals'],
    queryFn: () => api<Vitals>('/api/v1/admin/server/status'),
    refetchInterval: 10_000,
    retry: false,
  });

  return (
    <div className="min-h-screen bg-ink">
      <header className="border-b border-edge bg-panel">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <div className="flex items-center gap-3">
            <Link href="/projects" className="font-mono text-xs text-muted hover:text-body">
              ← projects
            </Link>
            <h1 className="text-sm font-medium text-body">KAIROS Server</h1>
            {data ? (
              <StateBadge state={data.online ? 'running' : 'failed'} label={data.online ? 'ONLINE' : 'DEGRADED'} />
            ) : isError ? (
              <StateBadge state="failed" label="UNREACHABLE" />
            ) : (
              <StateBadge state="unknown" label="…" />
            )}
          </div>

          {data ? (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
              <span className="font-mono text-xs text-muted">
                {data.system.os?.prettyName ?? data.system.host.hostname}
              </span>
              <Vital label="CPU" value={`${data.system.cpu.usagePercent}%`} alert={data.system.cpu.usagePercent > 90} />
              <Vital label="RAM" value={`${data.system.memory.usedPercent}%`} alert={data.system.memory.usedPercent > 90} />
              {data.system.disk.data ? (
                <Vital label="Disk" value={`${data.system.disk.data.usedPercent}%`} alert={data.system.disk.warning} />
              ) : null}
              {data.system.cpu.temperatureC !== null ? (
                <Vital
                  label="Temp"
                  value={`${data.system.cpu.temperatureC}°C`}
                  alert={data.system.cpu.throttling}
                />
              ) : null}
              <Vital label="Firewall" value={data.firewall.active ? 'active' : 'OFF'} alert={!data.firewall.active} />
            </div>
          ) : null}
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-8 px-6 py-8">
        <nav aria-label="Server sections" className="w-44 shrink-0">
          <ul className="space-y-0.5">
            {NAV.map((item) => {
              const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={`block rounded px-3 py-1.5 text-sm transition-colors ${
                      active ? 'bg-raised text-body' : 'text-muted hover:bg-raised hover:text-body'
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
