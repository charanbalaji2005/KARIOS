'use client';

/**
 * Services.
 *
 * Start, stop and restart the things KAIROS manages — and nothing else. The
 * list comes from the agent, which reports what it actually found on the host
 * rather than what a config file claims should be there, including the case
 * where a service exists both as a systemd unit and as a container.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { Button, Panel, Alert, Skeleton } from '@/components/ui';
import { StateBadge, DangerDialog, Output, AgentOffline, type DangerAction } from '@/components/server-ui';
import type { ServiceReport, AgentStatus } from '@/lib/server';
import { sortServices } from '@/lib/server';

type Action = 'start' | 'stop' | 'restart';

/** The phrases the agent will check. Mirrored here so the dialog shows the truth. */
const CONFIRM_PHRASE: Record<Action, string | null> = {
  start: null,
  stop: 'STOP SERVICE',
  restart: 'RESTART SERVICE',
};

export default function ServicesPage() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<{ service: ServiceReport; action: Action } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ service: string; output: string } | null>(null);

  const agent = useQuery({
    queryKey: ['server-agent'],
    queryFn: () => api<AgentStatus>('/api/v1/admin/server/agent'),
    retry: false,
  });

  const services = useQuery({
    queryKey: ['server-services'],
    queryFn: () => api<{ services: ServiceReport[]; healthy: boolean; coreDown: string[] }>('/api/v1/admin/server/services'),
    refetchInterval: 15_000,
    retry: false,
    enabled: agent.data?.reachable === true,
  });

  const run = async (service: ServiceReport, action: Action, confirm?: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ state: string; output: string }>(`/api/v1/admin/server/services/${service.id}`, {
        method: 'POST',
        body: JSON.stringify({ action, ...(confirm ? { confirm } : {}) }),
      });
      setResult({ service: service.label, output: response.output });
      setPending(null);
      // Read the state back rather than assuming the action worked.
      void queryClient.invalidateQueries({ queryKey: ['server-services'] });
      void queryClient.invalidateQueries({ queryKey: ['server-status'] });
      void queryClient.invalidateQueries({ queryKey: ['server-vitals'] });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'The action failed.';
      const output = err instanceof ApiError ? ((err.details as { output?: string })?.output ?? '') : '';
      setError(message);
      if (output) setResult({ service: service.label, output });
    } finally {
      setBusy(false);
    }
  };

  const request = (service: ServiceReport, action: Action) => {
    setError(null);
    setResult(null);
    if (CONFIRM_PHRASE[action] === null) {
      void run(service, action);
      return;
    }
    setPending({ service, action });
  };

  if (agent.isLoading) return <Skeleton rows={6} />;
  if (!agent.data?.reachable) {
    return <AgentOffline detail={agent.data?.detail ?? 'unknown'} configured={agent.data?.configured ?? false} />;
  }
  if (services.isLoading) return <Skeleton rows={8} />;
  if (services.error || !services.data) {
    return <Alert>Could not read services: {(services.error as Error)?.message ?? 'unknown error'}</Alert>;
  }

  const list = sortServices(services.data.services);
  const installed = list.filter((service) => service.state !== 'not_installed');
  const missing = list.filter((service) => service.state === 'not_installed');

  const dangerAction: DangerAction | null = pending
    ? {
        title: `${pending.action === 'stop' ? 'Stop' : 'Restart'} ${pending.service.label}`,
        description: (
          <>
            <p>{pending.service.description}</p>
            {pending.service.core ? (
              <p className="mt-2 text-coral">
                This is a core service. The platform is degraded or offline while it is down.
              </p>
            ) : null}
            {pending.service.id === 'nginx' ? (
              <p className="mt-2">
                If the NGINX config does not parse it will not come back, and nothing will be reachable from outside this
                machine. Check the Network page first.
              </p>
            ) : null}
            {pending.service.id === 'dashboard' ? (
              <p className="mt-2">Restarting the dashboard ends this page. The database is unaffected.</p>
            ) : null}
          </>
        ),
        confirmPhrase: CONFIRM_PHRASE[pending.action]!,
        actionLabel: pending.action === 'stop' ? 'Stop it' : 'Restart it',
      }
    : null;

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl text-body">Services</h1>
          <p className="mt-1 text-sm text-muted">
            The processes KAIROS manages on this host. Anything not in this list is not controllable from the dashboard.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => services.refetch()}>
          Refresh
        </Button>
      </header>

      {services.data.coreDown.length > 0 ? (
        <Alert>
          Core services are not running: {services.data.coreDown.join(', ')}. The platform is degraded until they are
          back.
        </Alert>
      ) : null}

      {error ? <Alert>{error}</Alert> : null}

      {result ? (
        <Panel title={`Result — ${result.service}`} action={<Button size="sm" variant="ghost" onClick={() => setResult(null)}>Dismiss</Button>}>
          <Output text={result.output} />
        </Panel>
      ) : null}

      <div className="space-y-3">
        {installed.map((service) => (
          <article key={service.id} className="rounded-lg border border-edge bg-panel p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-medium text-body">{service.label}</h2>
                  <StateBadge state={service.state} />
                  {service.core ? (
                    <span className="rounded border border-edge px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted">
                      core
                    </span>
                  ) : null}
                </div>
                <p className="mt-1.5 text-sm text-muted">{service.description}</p>

                <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-muted">
                  {service.systemd && service.systemd.state !== 'not_installed' ? (
                    <div>
                      <dt className="inline">systemd </dt>
                      <dd className="inline text-body">
                        {service.systemd.unit}: {service.systemd.detail}
                        {service.systemd.enabled === false ? (
                          <span className="text-amber"> · not enabled on boot</span>
                        ) : null}
                      </dd>
                    </div>
                  ) : null}
                  {service.docker && service.docker.state !== 'not_installed' ? (
                    <div>
                      <dt className="inline">docker </dt>
                      <dd className="inline text-body">
                        {service.docker.container}: {service.docker.status}
                        {service.docker.health ? ` · health ${service.docker.health}` : ''}
                      </dd>
                    </div>
                  ) : null}
                </dl>

                {service.conflict ? (
                  <p className="mt-3 rounded border border-[#4A2B2B] bg-[#241A1A] px-3 py-2 text-xs text-coral">
                    {service.conflict}
                  </p>
                ) : null}
              </div>

              {service.id !== 'agent' && service.id !== 'docker' ? (
                <div className="flex shrink-0 gap-2">
                  {service.state !== 'running' ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => request(service, 'start')}>
                      Start
                    </Button>
                  ) : null}
                  {service.state === 'running' ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => request(service, 'stop')}>
                      Stop
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => request(service, 'restart')}>
                    Restart
                  </Button>
                </div>
              ) : (
                <p className="max-w-[16rem] shrink-0 text-right text-xs text-muted">
                  {service.id === 'agent'
                    ? 'The agent will not restart itself from a request it is serving.'
                    : 'Docker is readable but not controllable from here.'}
                </p>
              )}
            </div>
          </article>
        ))}
      </div>

      {missing.length > 0 ? (
        <Panel title="Not installed on this host">
          <ul className="space-y-1.5">
            {missing.map((service) => (
              <li key={service.id} className="flex items-center justify-between text-sm">
                <span className="text-muted">{service.label}</span>
                <span className="font-mono text-xs text-muted">no unit, no container</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">
            These are optional, or not provisioned yet. The setup wizard installs the ones KAIROS needs.
          </p>
        </Panel>
      ) : null}

      <DangerDialog
        open={pending !== null}
        action={dangerAction}
        busy={busy}
        error={error}
        onCancel={() => setPending(null)}
        onConfirm={(phrase) => {
          if (pending) void run(pending.service, pending.action, phrase);
        }}
      />
    </div>
  );
}
