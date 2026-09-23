'use client';

/**
 * Server setup wizard.
 *
 * Resumable, because provisioning a laptop is not a five-minute job and people
 * close laptops. Every step splits into a check that is safe to run at any
 * time and an apply that changes the machine — and the recorded status is
 * never trusted on its own: a step shows green because its check said so just
 * now, not because it once succeeded.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { Button, Panel, Alert, Skeleton } from '@/components/ui';
import { StateBadge, DangerDialog, Output, AgentOffline, type DangerAction } from '@/components/server-ui';
import type { AgentStatus } from '@/lib/server';

interface SetupStep {
  step: string;
  title: string;
  description: string;
  check: string;
  apply: string | null;
  recorded: { status: string; detail: string | null; updated_at: string } | null;
}

interface StepResult {
  step: string;
  mode: 'check' | 'apply';
  ok: boolean;
  satisfied: boolean;
  output: string;
  error: string | null;
}

/** Confirmation phrases for the applies that are marked dangerous by the agent. */
const APPLY_CONFIRM: Record<string, { phrase: string; title: string; description: string }> = {
  dependencies: {
    phrase: 'INSTALL PACKAGES',
    title: 'Install missing packages',
    description:
      'Runs apt-get install for the packages KAIROS requires. This changes the machine outside KAIROS’s own footprint. Docker is not installed this way — it comes from Docker’s own repository, which install-server.sh configures.',
  },
  firewall: {
    phrase: 'APPLY FIREWALL',
    title: 'Apply the baseline firewall',
    description:
      'Installs the KAIROS nftables table: inbound dropped by default, HTTPS open, PostgreSQL and Redis never listed. Established connections are accepted, so you will not lose this page.',
  },
};

export default function SetupPage() {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, StepResult>>({});
  const [pendingApply, setPendingApply] = useState<SetupStep | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const agent = useQuery({
    queryKey: ['server-agent'],
    queryFn: () => api<AgentStatus>('/api/v1/admin/server/agent'),
    retry: false,
  });

  const setup = useQuery({
    queryKey: ['server-setup'],
    queryFn: () => api<{ steps: SetupStep[]; note: string }>('/api/v1/admin/server/setup'),
    retry: false,
    enabled: agent.data?.reachable === true,
  });

  const run = async (step: SetupStep, mode: 'check' | 'apply', confirm?: string) => {
    setRunning(`${step.step}:${mode}`);
    setDialogError(null);
    try {
      const result = await api<StepResult>(`/api/v1/admin/server/setup/${step.step}/${mode}`, {
        method: 'POST',
        body: JSON.stringify(confirm ? { confirm } : {}),
      });
      setResults((current) => ({ ...current, [step.step]: result }));
      setPendingApply(null);
      void queryClient.invalidateQueries({ queryKey: ['server-setup'] });
      if (mode === 'apply') {
        void queryClient.invalidateQueries({ queryKey: ['server-status'] });
        void queryClient.invalidateQueries({ queryKey: ['server-vitals'] });
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'The step failed.';
      setDialogError(message);
      setResults((current) => ({
        ...current,
        [step.step]: { step: step.step, mode, ok: false, satisfied: false, output: '', error: message },
      }));
    } finally {
      setRunning(null);
    }
  };

  const requestApply = (step: SetupStep) => {
    if (APPLY_CONFIRM[step.step]) {
      setDialogError(null);
      setPendingApply(step);
      return;
    }
    void run(step, 'apply');
  };

  const runAllChecks = async () => {
    for (const step of setup.data?.steps ?? []) {
      // Sequential, not parallel: several of these shell out to systemd and
      // Docker, and ten at once on a laptop is a load spike on the machine the
      // wizard is trying to assess.
      await run(step, 'check');
    }
  };

  if (agent.isLoading) return <Skeleton rows={6} />;
  if (!agent.data?.reachable) {
    return <AgentOffline detail={agent.data?.detail ?? 'unknown'} configured={agent.data?.configured ?? false} />;
  }
  if (setup.isLoading || !setup.data) return <Skeleton rows={10} />;

  const steps = setup.data.steps;
  const completed = steps.filter((step) => results[step.step]?.satisfied ?? step.recorded?.status === 'completed').length;

  const dangerAction: DangerAction | null =
    pendingApply && APPLY_CONFIRM[pendingApply.step]
      ? {
          title: APPLY_CONFIRM[pendingApply.step]!.title,
          description: <p>{APPLY_CONFIRM[pendingApply.step]!.description}</p>,
          confirmPhrase: APPLY_CONFIRM[pendingApply.step]!.phrase,
          actionLabel: 'Apply',
        }
      : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl text-body">Setup</h1>
          <p className="mt-1 text-sm text-muted">
            Turn this Ubuntu machine into a KAIROS server. Every step is safe to re-run.
          </p>
        </div>
        <Button variant="ghost" onClick={runAllChecks} disabled={running !== null}>
          {running ? 'Checking…' : 'Run every check'}
        </Button>
      </header>

      <div className="rounded-lg border border-edge bg-panel px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-body">
            {completed} of {steps.length} steps satisfied
          </span>
          <span className="font-mono text-xs text-muted">{Math.round((completed / steps.length) * 100)}%</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
          <div
            className="h-full bg-signal transition-[width] duration-500"
            style={{ width: `${(completed / steps.length) * 100}%` }}
          />
        </div>
      </div>

      <ol className="space-y-3">
        {steps.map((step, index) => {
          const result = results[step.step];
          const recorded = step.recorded;
          const state = result
            ? result.satisfied
              ? 'running'
              : result.ok
                ? 'unknown'
                : 'failed'
            : recorded?.status === 'completed'
              ? 'running'
              : recorded?.status === 'failed'
                ? 'failed'
                : 'stopped';

          const label = result
            ? result.satisfied
              ? 'SATISFIED'
              : result.ok
                ? 'NEEDS WORK'
                : 'FAILED'
            : recorded?.status
              ? recorded.status.toUpperCase()
              : 'NOT CHECKED';

          const checking = running === `${step.step}:check`;
          const applying = running === `${step.step}:apply`;

          return (
            <li key={step.step}>
              <article className="rounded-lg border border-edge bg-panel p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-xs text-muted">{String(index + 1).padStart(2, '0')}</span>
                      <h2 className="text-sm font-medium text-body">{step.title}</h2>
                      <StateBadge state={state} label={label} />
                    </div>
                    <p className="mt-1.5 pl-8 text-sm text-muted">{step.description}</p>
                    {recorded?.updated_at && !result ? (
                      <p className="mt-1 pl-8 font-mono text-xs text-muted">
                        last run {new Date(recorded.updated_at).toLocaleString()}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="ghost" disabled={running !== null} onClick={() => run(step, 'check')}>
                      {checking ? 'Checking…' : 'Check'}
                    </Button>
                    {step.apply ? (
                      <Button size="sm" variant="primary" disabled={running !== null} onClick={() => requestApply(step)}>
                        {applying ? 'Applying…' : 'Apply'}
                      </Button>
                    ) : null}
                  </div>
                </div>

                {result?.error ? (
                  <div className="mt-3 pl-8">
                    <Alert>{result.error}</Alert>
                  </div>
                ) : null}

                {result?.output ? (
                  <div className="mt-3 pl-8">
                    <Output text={result.output} />
                  </div>
                ) : null}

                {!step.apply && result && !result.satisfied ? (
                  <p className="mt-3 pl-8 text-xs text-muted">
                    This step has no automatic fix — it reports what the host looks like so you can decide what to change.
                  </p>
                ) : null}
              </article>
            </li>
          );
        })}
      </ol>

      <Panel title="When the checks all pass">
        <p className="text-sm text-muted">
          The server is provisioned, but it is not yet reachable from anywhere else. Two things remain, and both are
          deliberately outside the dashboard because both involve credentials this API should never hold:
        </p>
        <ol className="mt-3 space-y-2 text-sm text-muted">
          <li>
            <span className="text-body">1. A hostname and a certificate.</span> Point a name at this machine and run{' '}
            <code className="font-mono text-body">./scripts/tls-issue.sh your-domain</code>, or start a Cloudflare Tunnel
            and skip opening a router port entirely.
          </li>
          <li>
            <span className="text-body">2. Verify the perimeter from somewhere else.</span> Run{' '}
            <code className="font-mono text-body">./scripts/verify-security.sh &lt;host&gt;</code> from a different
            machine. A firewall check run on the machine itself is not a test of the firewall.
          </li>
        </ol>
      </Panel>

      <DangerDialog
        open={pendingApply !== null && dangerAction !== null}
        action={dangerAction}
        busy={running !== null}
        error={dialogError}
        onCancel={() => setPendingApply(null)}
        onConfirm={(phrase) => {
          if (pendingApply) void run(pendingApply, 'apply', phrase);
        }}
      />
    </div>
  );
}
