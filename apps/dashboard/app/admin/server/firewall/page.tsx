'use client';

/**
 * Firewall.
 *
 * The dashboard cannot write rules. It can ask for one of four named outcomes
 * and the agent generates the ruleset itself — because a firewall a web
 * request can write arbitrary rules into is a firewall an attacker can write
 * arbitrary rules into.
 *
 * The page pairs *intent* with *reality*: what the ruleset says, and what is
 * actually listening. Those disagree more often than anyone expects, and the
 * disagreement is where the incident lives.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { Button, Panel, Alert, Skeleton, Input, Field } from '@/components/ui';
import { StateBadge, DangerDialog, Output, AgentOffline, type DangerAction } from '@/components/server-ui';
import type { AgentStatus, FirewallStatus } from '@/lib/server';

type ActionId = 'baseline' | 'open-https' | 'close-https' | 'ssh';

const ACTIONS: Record<ActionId, { title: string; confirmPhrase: string; label: string; describe: JSX.Element }> = {
  baseline: {
    title: 'Apply the KAIROS baseline ruleset',
    confirmPhrase: 'APPLY FIREWALL',
    label: 'Apply it',
    describe: (
      <>
        <p>
          Installs an <code className="font-mono">inet kairos</code> nftables table: inbound dropped by default, loopback
          and established traffic allowed, HTTPS open, and PostgreSQL, Redis and the storage ports never listed — which
          is why they become unreachable.
        </p>
        <p className="mt-2">
          Only the KAIROS table is replaced, so Docker&apos;s own chains survive. If you are reading this over the network,
          you will keep your connection: established traffic is accepted.
        </p>
      </>
    ),
  },
  'open-https': {
    title: 'Open HTTPS on 443',
    confirmPhrase: 'OPEN HTTPS',
    label: 'Open it',
    describe: <p>Accept inbound connections on 443. This is how other devices reach the KAIROS API.</p>,
  },
  'close-https': {
    title: 'Close HTTPS',
    confirmPhrase: 'CLOSE HTTPS',
    label: 'Close it',
    describe: (
      <p className="text-coral">
        Nothing outside this machine will be able to reach KAIROS — including this dashboard, if you did not open it on
        localhost. Make sure you have another way in before continuing.
      </p>
    ),
  },
  ssh: {
    title: 'Change SSH access',
    confirmPhrase: 'CHANGE SSH ACCESS',
    label: 'Apply',
    describe: (
      <p>
        Restrict SSH to one source network, or close it entirely by leaving the field empty. If you close it and have no
        physical access to this machine, you will not get back in.
      </p>
    ),
  },
};

export default function FirewallPage() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<ActionId | null>(null);
  const [sshSource, setSshSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [showRules, setShowRules] = useState(false);

  const agent = useQuery({
    queryKey: ['server-agent'],
    queryFn: () => api<AgentStatus>('/api/v1/admin/server/agent'),
    retry: false,
  });

  const firewall = useQuery({
    queryKey: ['server-firewall'],
    queryFn: () => api<FirewallStatus & { output: string }>('/api/v1/admin/server/inspect/firewall'),
    refetchInterval: 30_000,
    retry: false,
    enabled: agent.data?.reachable === true,
  });

  const rules = useQuery({
    queryKey: ['server-firewall-rules'],
    queryFn: () => api<{ backend: string; ruleset: string | null }>('/api/v1/admin/server/inspect/firewall-rules'),
    retry: false,
    enabled: showRules,
  });

  const apply = async (action: ActionId, confirm: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ output: string }>(`/api/v1/admin/server/firewall/${action}`, {
        method: 'POST',
        body: JSON.stringify({
          confirm,
          ...(action === 'ssh' && sshSource.trim() ? { source: sshSource.trim() } : {}),
        }),
      });
      setOutput(response.output);
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: ['server-firewall'] });
      void queryClient.invalidateQueries({ queryKey: ['server-firewall-rules'] });
      void queryClient.invalidateQueries({ queryKey: ['server-vitals'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The firewall change failed.');
      const details = err instanceof ApiError ? (err.details as { output?: string })?.output : undefined;
      if (details) setOutput(details);
    } finally {
      setBusy(false);
    }
  };

  if (agent.isLoading) return <Skeleton rows={6} />;
  if (!agent.data?.reachable) {
    return <AgentOffline detail={agent.data?.detail ?? 'unknown'} configured={agent.data?.configured ?? false} />;
  }
  if (firewall.isLoading) return <Skeleton rows={8} />;
  if (firewall.error || !firewall.data) {
    return <Alert>Could not read the firewall: {(firewall.error as Error)?.message ?? 'unknown error'}</Alert>;
  }

  const data = firewall.data;
  const critical = data.exposure.filter((finding) => finding.severity === 'critical');
  const warnings = data.exposure.filter((finding) => finding.severity === 'warning');

  const dangerAction: DangerAction | null = pending
    ? {
        title: ACTIONS[pending].title,
        description: ACTIONS[pending].describe,
        confirmPhrase: ACTIONS[pending].confirmPhrase,
        actionLabel: ACTIONS[pending].label,
      }
    : null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl text-body">Firewall</h1>
        <p className="mt-1 text-sm text-muted">
          What this machine accepts from the network. The dashboard asks for named outcomes; the agent writes the rules.
        </p>
      </header>

      {!data.active ? (
        <Alert>
          Inbound traffic is not denied by default. Every port this machine listens on is reachable from whatever network
          it is attached to, including PostgreSQL if it is bound past loopback.
        </Alert>
      ) : null}

      {critical.length > 0 ? (
        <Alert>
          <strong className="block">An internal service is bound to a public interface.</strong>
          <ul className="mt-2 space-y-1">
            {critical.map((finding) => (
              <li key={`${finding.port}-${finding.address}`}>{finding.message}</li>
            ))}
          </ul>
          <p className="mt-2">
            The firewall may still be dropping these packets, but a service bound wide is one misapplied ruleset away from
            being reachable. Bind it to 127.0.0.1 as well.
          </p>
        </Alert>
      ) : null}

      {error ? <Alert>{error}</Alert> : null}

      <section className="grid gap-6 lg:grid-cols-2">
        <Panel title="Status">
          <dl className="space-y-2.5">
            <div className="flex items-center justify-between">
              <dt className="text-sm text-muted">Firewall</dt>
              <dd>
                <StateBadge state={data.active ? 'active' : 'failed'} label={data.active ? 'ACTIVE' : 'INACTIVE'} />
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-sm text-muted">Backend</dt>
              <dd className="font-mono text-xs text-body">{data.backend}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-sm text-muted">Inbound default</dt>
              <dd className="font-mono text-xs text-body">{data.defaultPolicy ?? 'unknown'}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-sm text-muted">KAIROS ruleset</dt>
              <dd className="font-mono text-xs text-body">{data.kairosTable ? 'installed' : 'not installed'}</dd>
            </div>
          </dl>

          <div className="mt-5">
            <p className="text-xs uppercase tracking-wide text-muted">Open</p>
            <ul className="mt-2 space-y-1">
              {data.open.length === 0 ? (
                <li className="font-mono text-xs text-muted">nothing</li>
              ) : (
                data.open.map((entry) => (
                  <li key={entry.port} className="font-mono text-xs text-body">
                    {entry.port} · {entry.service}
                  </li>
                ))
              )}
            </ul>
          </div>

          <div className="mt-5">
            <p className="text-xs uppercase tracking-wide text-muted">Never exposed</p>
            <ul className="mt-2 space-y-1">
              {data.blockedByDesign.map((entry) => (
                <li key={entry.port} className="font-mono text-xs text-muted">
                  {entry.port} · {entry.service}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">
              These are not blocked by a deny rule — they are simply never allowed, so the default drop covers them.
            </p>
          </div>
        </Panel>

        <Panel title="Actions">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm text-body">Apply the baseline ruleset</p>
                <p className="text-xs text-muted">Deny inbound, allow HTTPS, keep the database private.</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setPending('baseline')} disabled={busy}>
                Apply
              </Button>
            </div>

            <div className="flex items-center justify-between gap-4 border-t border-edge pt-3">
              <div>
                <p className="text-sm text-body">HTTPS on 443</p>
                <p className="text-xs text-muted">
                  Currently {data.intent.httpsOpen ? 'open' : 'closed'}.
                </p>
              </div>
              <Button
                size="sm"
                variant={data.intent.httpsOpen ? 'danger' : 'ghost'}
                onClick={() => setPending(data.intent.httpsOpen ? 'close-https' : 'open-https')}
                disabled={busy}
              >
                {data.intent.httpsOpen ? 'Close' : 'Open'}
              </Button>
            </div>

            <div className="border-t border-edge pt-3">
              <p className="text-sm text-body">SSH</p>
              <p className="text-xs text-muted">
                {data.intent.sshFrom ? `Restricted to ${data.intent.sshFrom}.` : 'Closed at the firewall.'}
              </p>
              <div className="mt-2 flex items-end gap-2">
                <Field label="Allow from" hint="A CIDR such as 192.168.1.0/24. Leave empty to close SSH.">
                  <Input
                    value={sshSource}
                    onChange={(event) => setSshSource(event.target.value)}
                    placeholder={data.intent.sshFrom ?? '192.168.1.0/24'}
                    className="font-mono"
                  />
                </Field>
                <Button size="sm" variant="ghost" onClick={() => setPending('ssh')} disabled={busy}>
                  Apply
                </Button>
              </div>
            </div>
          </div>
        </Panel>
      </section>

      {warnings.length > 0 ? (
        <Panel title="Other listeners">
          <ul className="space-y-1.5">
            {warnings.map((finding) => (
              <li key={`${finding.port}-${finding.address}`} className="text-xs text-amber">
                {finding.message}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {output ? (
        <Panel title="Output" action={<Button size="sm" variant="ghost" onClick={() => setOutput(null)}>Dismiss</Button>}>
          <Output text={output} />
        </Panel>
      ) : null}

      <Panel
        title="Loaded ruleset"
        action={
          <Button size="sm" variant="ghost" onClick={() => setShowRules((value) => !value)}>
            {showRules ? 'Hide' : 'Show'}
          </Button>
        }
      >
        {showRules ? (
          rules.isLoading ? (
            <Skeleton rows={4} />
          ) : (
            <Output text={rules.data?.ruleset ?? 'No firewall tool is installed on this host.'} className="max-h-[32rem]" />
          )
        ) : (
          <p className="text-sm text-muted">
            The rules the kernel has loaded right now, verbatim — not what KAIROS believes it applied.
          </p>
        )}
      </Panel>

      <DangerDialog
        open={pending !== null}
        action={dangerAction}
        busy={busy}
        error={error}
        onCancel={() => setPending(null)}
        onConfirm={(phrase) => {
          if (pending) void apply(pending, phrase);
        }}
      />
    </div>
  );
}
