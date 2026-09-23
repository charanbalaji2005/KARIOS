'use client';

/**
 * Connections — the point of the whole product.
 *
 * Everything else in this console exists so that this page can be true: the
 * laptop is the server, and another machine can query its PostgreSQL through
 * the KAIROS API without installing PostgreSQL, opening 5432, or renting
 * anything.
 *
 * So this page is not a settings screen. It is the "here is how you connect"
 * screen, with the endpoint, the identity, and code that works.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button, Panel, Alert, Skeleton } from '@/components/ui';
import { StateBadge, AgentOffline } from '@/components/server-ui';
import type { AgentStatus } from '@/lib/server';

interface ServerInfo {
  serverId: string;
  serverName: string;
  networkMode: 'local' | 'lan' | 'remote';
  installedAt: string;
  host: { hostname: string; platform: string; release: string };
  versions: Record<string, string>;
  storage: { driver: string; dataRoot: string };
  reachableAt: string[];
}

interface Identity {
  serverId: string;
  publicKey: string;
  createdAt: string;
  hostname: string;
}

const MODE_COPY: Record<ServerInfo['networkMode'], { label: string; detail: string; tone: 'ok' | 'warn' }> = {
  local: {
    label: 'LOCAL',
    detail: 'Loopback only. Nothing off this machine can reach KAIROS, including other devices on your own network.',
    tone: 'warn',
  },
  lan: {
    label: 'LAN',
    detail: 'Other devices on the same network can reach this server. Your phone on the same Wi-Fi works; the internet does not.',
    tone: 'ok',
  },
  remote: {
    label: 'REMOTE',
    detail: 'Reachable from the internet through a tunnel or a forwarded port. Only NGINX is exposed — PostgreSQL and Redis never are.',
    tone: 'ok',
  },
};

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <div className="flex items-center justify-between border-b border-edge px-3 py-1.5">
        <span className="font-mono text-xs uppercase tracking-wide text-muted">{language}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1_500);
            });
          }}
          className="font-mono text-xs text-muted transition-colors hover:text-body"
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="overflow-auto px-3 py-3 font-mono text-xs leading-relaxed text-body">{code}</pre>
    </div>
  );
}

export default function ConnectionsPage() {
  const agent = useQuery({
    queryKey: ['server-agent'],
    queryFn: () => api<AgentStatus>('/api/v1/admin/server/agent'),
    retry: false,
  });

  const info = useQuery({
    queryKey: ['server-info'],
    queryFn: () => api<ServerInfo>('/api/v1/server/info'),
    retry: false,
  });

  const identity = useQuery({
    queryKey: ['server-identity'],
    queryFn: () => api<Identity>('/api/v1/admin/server/identity'),
    retry: false,
    enabled: agent.data?.reachable === true,
  });

  if (info.isLoading) return <Skeleton rows={8} />;
  if (info.error || !info.data) {
    return <Alert>Could not read server info: {(info.error as Error)?.message ?? 'unknown error'}</Alert>;
  }

  const data = info.data;
  const mode = MODE_COPY[data.networkMode];
  const endpoint = data.reachableAt[0] ?? 'http://localhost:4000';

  const jsExample = `import { createClient } from "@kairosdb/client";

const db = createClient(
  "${endpoint}",
  "krs_anon_..."          // from your project's Keys page
);

const { data, error } = await db
  .from("profiles")
  .select("*")
  .eq("active", true);`;

  const pythonExample = `import httpx

KAIROS = "${endpoint}"
ANON_KEY = "krs_anon_..."   # from your project's Keys page

response = httpx.get(
    f"{KAIROS}/rest/v1/profiles",
    params={"active": "eq.true", "select": "id,email"},
    headers={"apikey": ANON_KEY},
)
print(response.json())`;

  const curlExample = `curl "${endpoint}/rest/v1/profiles?active=eq.true&select=id,email" \\
  -H "apikey: krs_anon_..."`;

  const cliExample = `# On the other machine
npm install -g @kairosdb/cli

export KAIROS_API_URL="${endpoint}"
kairos login
kairos projects list
kairos server status`;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl text-body">Connections</h1>
        <p className="mt-1 text-sm text-muted">
          How another machine reaches the database on this one.
        </p>
      </header>

      <Panel title="This server">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-3">
              <span className="text-lg text-body">{data.serverName}</span>
              <StateBadge state="running" label="ONLINE" />
            </div>
            <dl className="mt-3 space-y-1.5 font-mono text-xs">
              <div className="flex gap-3">
                <dt className="w-24 text-muted">server id</dt>
                <dd className="text-body">{identity.data?.serverId ?? data.serverId}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-24 text-muted">endpoint</dt>
                <dd className="text-body">{endpoint}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-24 text-muted">host</dt>
                <dd className="text-muted">
                  {data.host.hostname} · {data.host.platform} {data.host.release}
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-24 text-muted">postgres</dt>
                <dd className="text-muted">{data.versions.postgres}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-24 text-muted">storage</dt>
                <dd className="text-muted">
                  {data.storage.driver} at {data.storage.dataRoot}
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-24 text-muted">installed</dt>
                <dd className="text-muted">{new Date(data.installedAt).toLocaleDateString()}</dd>
              </div>
            </dl>
          </div>

          <div className="max-w-sm rounded border border-edge bg-raised px-4 py-3">
            <div className="flex items-center gap-2">
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${mode.tone === 'ok' ? 'bg-mint' : 'bg-amber'}`}
                aria-hidden
              />
              <span className="font-mono text-xs uppercase tracking-wide text-body">{mode.label}</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted">{mode.detail}</p>
          </div>
        </div>
      </Panel>

      {data.networkMode === 'local' ? (
        <Alert>
          The server is in local mode, so the examples below will only work from this machine. Change the network mode to{' '}
          <code className="font-mono">lan</code> to reach it from your phone, or <code className="font-mono">remote</code>{' '}
          with a tunnel to reach it from anywhere.
        </Alert>
      ) : null}

      {data.reachableAt.length > 1 ? (
        <Panel title="Reachable at">
          <ul className="space-y-1">
            {data.reachableAt.map((address) => (
              <li key={address} className="font-mono text-sm text-body">
                {address}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel title="Connect from another machine">
        <p className="mb-4 text-sm text-muted">
          The other machine installs nothing but a client library. It never speaks to PostgreSQL directly — it speaks to
          the KAIROS API, which is the only thing this server exposes.
        </p>
        <div className="space-y-4">
          <div className="overflow-hidden rounded border border-edge bg-ink">
            <CodeBlock language="JavaScript / TypeScript" code={jsExample} />
          </div>
          <div className="overflow-hidden rounded border border-edge bg-ink">
            <CodeBlock language="Python" code={pythonExample} />
          </div>
          <div className="overflow-hidden rounded border border-edge bg-ink">
            <CodeBlock language="curl" code={curlExample} />
          </div>
          <div className="overflow-hidden rounded border border-edge bg-ink">
            <CodeBlock language="CLI" code={cliExample} />
          </div>
        </div>
        <p className="mt-4 text-xs text-muted">
          The <code className="font-mono">anon</code> key is public by design — it identifies the project, and row-level
          security is what decides which rows the caller can see. The{' '}
          <code className="font-mono">service_role</code> key bypasses RLS and must never reach a browser.
        </p>
      </Panel>

      <Panel title="Server identity">
        {identity.data ? (
          <>
            <p className="text-sm text-muted">
              An Ed25519 keypair generated once on this machine. The id is derived from the public key, so anyone holding
              the key can recompute the id and check it matches — which is how a client confirms it reached the server it
              enrolled with, and not something that answered on the same address.
            </p>
            <div className="mt-3 overflow-hidden rounded border border-edge bg-ink">
              <CodeBlock language="Public key" code={identity.data.publicKey.trim()} />
            </div>
            <p className="mt-3 text-xs text-muted">
              The private half lives in <code className="font-mono">/etc/kairos/server-key.pem</code> at mode 0600 and is
              never returned by any API. There is no endpoint that could be tricked into revealing it, because there is no
              endpoint for it at all.
            </p>
          </>
        ) : agent.data?.reachable ? (
          <Skeleton rows={3} />
        ) : (
          <p className="text-sm text-muted">The agent is not running, so the host key cannot be read.</p>
        )}
      </Panel>

      <Panel title="What crosses the network">
        <pre className="overflow-auto font-mono text-xs leading-relaxed text-muted">
{`  Laptop B                              Laptop A (this machine)
  ────────                              ───────────────────────
  @kairosdb/client
        │
        │  HTTPS + apikey
        ▼
   Cloudflare / your network
        │
        ▼
                                        firewall   (inbound: drop)
                                            │
                                        NGINX :443 (TLS, rate limits)
                                            │
                                        KAIROS API (RLS applied here)
                                            │
                                        PostgreSQL :5432  ← loopback only
                                            │
                                          rows
        ◀───────────────────────────────────┘`}
        </pre>
        <p className="mt-3 text-xs text-muted">
          PostgreSQL is never on that path from the outside. The only thing listening to the network is NGINX.
        </p>
      </Panel>
    </div>
  );
}
