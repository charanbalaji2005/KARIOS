'use client';

/**
 * Server settings — the audit trail, the allowlist, and power.
 *
 * The allowlist is printed in full rather than summarised. It is the security
 * boundary of this entire console, and a boundary you cannot read is one you
 * cannot check.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { Button, Panel, Alert, Skeleton } from '@/components/ui';
import { StateBadge, DangerDialog, Output, AgentOffline, formatRelative, formatDuration, type DangerAction } from '@/components/server-ui';
import type { AgentStatus, OperationDescriptor } from '@/lib/server';

interface OperationHistory {
  id: string;
  operation: string;
  arguments: Record<string, unknown>;
  danger: boolean;
  started_at: string;
  completed_at: string | null;
  status: string;
  exit_code: number | null;
  error: string | null;
  email: string | null;
  ip_address: string | null;
}

interface TerminalSession {
  id: string;
  mode: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  ip_address: string | null;
  close_reason: string | null;
  email: string;
  command_count: number;
}

type PowerAction = 'reboot' | 'shutdown';

const POWER: Record<PowerAction, { phrase: string; title: string; label: string }> = {
  reboot: { phrase: 'REBOOT SERVER', title: 'Reboot this machine', label: 'Reboot in one minute' },
  shutdown: { phrase: 'SHUTDOWN SERVER', title: 'Power this machine off', label: 'Shut down in one minute' },
};

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [pendingPower, setPendingPower] = useState<PowerAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [showAllowlist, setShowAllowlist] = useState(false);

  const agent = useQuery({
    queryKey: ['server-agent'],
    queryFn: () => api<AgentStatus>('/api/v1/admin/server/agent'),
    retry: false,
  });

  const enabled = agent.data?.reachable === true;

  const operations = useQuery({
    queryKey: ['server-allowlist'],
    queryFn: () => api<{ operations: OperationDescriptor[]; note: string }>('/api/v1/admin/server/operations'),
    retry: false,
    enabled: enabled && showAllowlist,
  });

  const history = useQuery({
    queryKey: ['server-operation-history'],
    queryFn: () => api<{ operations: OperationHistory[] }>('/api/v1/admin/server/operations/history?limit=50'),
    refetchInterval: 30_000,
    retry: false,
  });

  const sessions = useQuery({
    queryKey: ['terminal-sessions'],
    queryFn: () => api<{ sessions: TerminalSession[] }>('/api/v1/admin/server/terminal/sessions'),
    refetchInterval: 30_000,
    retry: false,
  });

  const power = async (action: PowerAction | 'cancel', confirm?: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ output: string }>(`/api/v1/admin/server/power/${action}`, {
        method: 'POST',
        body: JSON.stringify(confirm ? { confirm } : {}),
      });
      setOutput(result.output);
      setPendingPower(null);
      void queryClient.invalidateQueries({ queryKey: ['server-operation-history'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The power action failed.');
    } finally {
      setBusy(false);
    }
  };

  if (agent.isLoading) return <Skeleton rows={6} />;

  const dangerAction: DangerAction | null = pendingPower
    ? {
        title: POWER[pendingPower].title,
        description: (
          <>
            <p>
              Scheduled one minute out rather than immediately, so the dashboard can tell you it worked and so you have a
              minute to change your mind. Use Cancel below to call it off.
            </p>
            {pendingPower === 'shutdown' ? (
              <p className="mt-2 text-coral">
                Nothing here can turn the machine back on. Do not do this unless it is physically in front of you.
              </p>
            ) : (
              <p className="mt-2">
                On the way back up, Docker restarts its containers, the agent restarts under systemd, and the firewall
                reloads from its config. Data on the volume is untouched.
              </p>
            )}
          </>
        ),
        confirmPhrase: POWER[pendingPower].phrase,
        actionLabel: POWER[pendingPower].label,
      }
    : null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl text-body">Settings</h1>
        <p className="mt-1 text-sm text-muted">The agent, the audit trail, and the two buttons nobody presses twice.</p>
      </header>

      {error ? <Alert>{error}</Alert> : null}
      {output ? (
        <Panel title="Result" action={<Button size="sm" variant="ghost" onClick={() => setOutput(null)}>Dismiss</Button>}>
          <Output text={output} />
        </Panel>
      ) : null}

      {/* ---- agent -------------------------------------------------- */}
      <Panel title="Server agent">
        {agent.data?.reachable ? (
          <dl className="space-y-2">
            <div className="flex items-center justify-between">
              <dt className="text-sm text-muted">Status</dt>
              <dd>
                <StateBadge state="running" label="REACHABLE" />
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-sm text-muted">Version</dt>
              <dd className="font-mono text-xs text-body">{agent.data.health?.version}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-sm text-muted">Uptime</dt>
              <dd className="font-mono text-xs text-body">{formatDuration(agent.data.health?.uptimeSeconds ?? 0)}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-sm text-muted">Transport</dt>
              <dd className="font-mono text-xs text-body">{agent.data.transport}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-sm text-muted">Socket</dt>
              <dd className="font-mono text-xs text-muted">{agent.data.socket}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-sm text-muted">Operations allowed</dt>
              <dd className="font-mono text-xs text-body">{agent.data.health?.operations}</dd>
            </div>
          </dl>
        ) : (
          <AgentOffline detail={agent.data?.detail ?? 'unknown'} configured={agent.data?.configured ?? false} />
        )}
      </Panel>

      {/* ---- allowlist ---------------------------------------------- */}
      <Panel
        title="Operation allowlist"
        action={
          <Button size="sm" variant="ghost" onClick={() => setShowAllowlist((value) => !value)} disabled={!enabled}>
            {showAllowlist ? 'Hide' : 'Show all'}
          </Button>
        }
      >
        <p className="text-sm text-muted">
          Everything this server can be asked to do, by id. There is no operation that runs an arbitrary command — the
          Ubuntu Terminal is a separate, time-limited grant and appears nowhere in this list.
        </p>

        {showAllowlist ? (
          operations.isLoading ? (
            <div className="mt-4">
              <Skeleton rows={5} />
            </div>
          ) : (
            <div className="mt-4 max-h-[32rem] overflow-auto">
              <table className="w-full text-left">
                <thead className="sticky top-0 bg-panel">
                  <tr className="border-b border-edge text-xs uppercase tracking-wide text-muted">
                    <th className="pb-2 font-normal">Operation</th>
                    <th className="pb-2 font-normal">Does</th>
                    <th className="pb-2 text-right font-normal">Confirm</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge">
                  {(operations.data?.operations ?? []).map((operation) => (
                    <tr key={operation.id}>
                      <td className="py-2 align-top font-mono text-xs text-body">{operation.id}</td>
                      <td className="py-2 align-top text-xs text-muted">{operation.summary}</td>
                      <td className="py-2 text-right align-top">
                        {operation.danger ? (
                          <code className="font-mono text-xs text-coral">{operation.confirmPhrase}</code>
                        ) : (
                          <span className="font-mono text-xs text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </Panel>

      {/* ---- audit -------------------------------------------------- */}
      <Panel title="Recent privileged operations">
        {history.isLoading ? (
          <Skeleton rows={5} />
        ) : (history.data?.operations.length ?? 0) === 0 ? (
          <p className="text-sm text-muted">Nothing recorded yet.</p>
        ) : (
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-panel">
                <tr className="border-b border-edge text-xs uppercase tracking-wide text-muted">
                  <th className="pb-2 font-normal">When</th>
                  <th className="pb-2 font-normal">Operation</th>
                  <th className="pb-2 font-normal">By</th>
                  <th className="pb-2 text-right font-normal">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {(history.data?.operations ?? []).map((entry) => (
                  <tr key={entry.id}>
                    <td className="py-2 text-xs text-muted">{formatRelative(entry.started_at)}</td>
                    <td className="py-2 font-mono text-xs">
                      <span className={entry.danger ? 'text-coral' : 'text-body'}>{entry.operation}</span>
                      {Object.keys(entry.arguments ?? {}).length > 0 ? (
                        <span className="ml-2 text-muted">{JSON.stringify(entry.arguments)}</span>
                      ) : null}
                    </td>
                    <td className="py-2 text-xs text-muted">{entry.email ?? 'unknown'}</td>
                    <td className="py-2 text-right">
                      <span
                        className={`font-mono text-xs ${
                          entry.status === 'succeeded'
                            ? 'text-mint'
                            : entry.status === 'running'
                              ? 'text-amber'
                              : 'text-coral'
                        }`}
                      >
                        {entry.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted">
          Each row is written before the operation runs, not after — so an operation that took the machine down still
          leaves a record of who asked for it.
        </p>
      </Panel>

      {/* ---- terminal sessions -------------------------------------- */}
      <Panel title="Terminal sessions">
        {sessions.isLoading ? (
          <Skeleton rows={4} />
        ) : (sessions.data?.sessions.length ?? 0) === 0 ? (
          <p className="text-sm text-muted">No terminal sessions yet.</p>
        ) : (
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-panel">
                <tr className="border-b border-edge text-xs uppercase tracking-wide text-muted">
                  <th className="pb-2 font-normal">Started</th>
                  <th className="pb-2 font-normal">Mode</th>
                  <th className="pb-2 font-normal">By</th>
                  <th className="pb-2 font-normal">From</th>
                  <th className="pb-2 text-right font-normal">Commands</th>
                  <th className="pb-2 text-right font-normal">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {(sessions.data?.sessions ?? []).map((entry) => (
                  <tr key={entry.id}>
                    <td className="py-2 text-xs text-muted">{new Date(entry.started_at).toLocaleString()}</td>
                    <td className="py-2 font-mono text-xs">
                      <span className={entry.mode === 'ubuntu_terminal' ? 'text-coral' : 'text-body'}>
                        {entry.mode === 'ubuntu_terminal' ? 'ubuntu' : 'kairos'}
                      </span>
                    </td>
                    <td className="py-2 text-xs text-muted">{entry.email}</td>
                    <td className="py-2 font-mono text-xs text-muted">{entry.ip_address ?? '—'}</td>
                    <td className="py-2 text-right font-mono text-xs text-body">{entry.command_count}</td>
                    <td className="py-2 text-right">
                      <span className={`font-mono text-xs ${entry.status === 'open' ? 'text-mint' : 'text-muted'}`}>
                        {entry.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted">
          Ubuntu Terminal sessions record that they happened and for how long, not what was typed. Capturing keystrokes
          would capture passwords typed into sudo, which is a worse outcome than the gap in the record.
        </p>
      </Panel>

      {/* ---- power --------------------------------------------------- */}
      <Panel title="Power">
        <p className="text-sm text-muted">
          Both are scheduled a minute out, so you can cancel. Everything running stops; data on the volume does not move.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="danger" disabled={busy || !enabled} onClick={() => setPendingPower('reboot')}>
            Reboot
          </Button>
          <Button variant="danger" disabled={busy || !enabled} onClick={() => setPendingPower('shutdown')}>
            Shut down
          </Button>
          <Button variant="ghost" disabled={busy || !enabled} onClick={() => power('cancel')}>
            Cancel a scheduled reboot
          </Button>
        </div>
      </Panel>

      <DangerDialog
        open={pendingPower !== null}
        action={dangerAction}
        busy={busy}
        error={error}
        onCancel={() => setPendingPower(null)}
        onConfirm={(phrase) => {
          if (pendingPower) void power(pendingPower, phrase);
        }}
      />
    </div>
  );
}
