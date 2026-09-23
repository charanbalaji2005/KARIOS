'use client';

/**
 * API explorer.
 *
 * A request builder against the project's own auto-REST surface, so a
 * developer can confirm what a call actually returns — with their real key,
 * their real data, their real RLS policies — before writing code that depends
 * on it.
 *
 * Timing is measured in the browser rather than reported by the server,
 * because it should include the network. A server-side number flatters the
 * platform and is not what the developer's code will experience.
 */

import { useState, use } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button, Field, Input, Panel, Alert } from '@/components/ui';

interface TableSummary { name: string; schema: string }
interface ApiKey { id: string; kind: string; prefix: string; name: string }

const METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;
type Method = (typeof METHODS)[number];

interface Result { status: number; durationMs: number; headers: Record<string, string>; body: string }

export default function ExplorerPage({ params }: { params: Promise<{ ref: string }> | { ref: string } }) {
  const { ref } = params instanceof Promise ? use(params) : params;

  const tables = useQuery({
    queryKey: ['tables', ref],
    queryFn: () => api<TableSummary[]>(`/api/v1/projects/${ref}/database/tables`),
  });
  const keys = useQuery({
    queryKey: ['keys', ref],
    queryFn: () => api<ApiKey[]>(`/api/v1/projects/${ref}/keys`),
  });

  const [method, setMethod] = useState<Method>('GET');
  const [table, setTable] = useState('');
  const [queryString, setQueryString] = useState('limit=10');
  const [body, setBody] = useState('{\n  \n}');
  const [apiKey, setApiKey] = useState('');
  const [userToken, setUserToken] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [running, setRunning] = useState(false);

  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  const path = `/rest/v1/${table}${queryString ? `?${queryString}` : ''}`;

  async function send() {
    if (!table || !apiKey) return;
    setRunning(true);
    setResult(null);
    const started = performance.now();
    try {
      const response = await fetch(`${apiBase}${path}`, {
        method,
        headers: {
          apikey: apiKey,
          'content-type': 'application/json',
          ...(userToken ? { authorization: `Bearer ${userToken}` } : {}),
        },
        ...(method === 'GET' || method === 'DELETE' ? {} : { body }),
      });
      const text = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* leave as-is */ }
      setResult({
        status: response.status,
        durationMs: Math.round(performance.now() - started),
        headers,
        body: pretty,
      });
    } catch (error) {
      setResult({ status: 0, durationMs: Math.round(performance.now() - started), headers: {}, body: String(error) });
    } finally {
      setRunning(false);
    }
  }

  const usingServiceRole = apiKey.startsWith('krs_srv_');

  return (
    <main className="px-8 py-10">
      <h1 className="text-xl font-semibold text-body">API explorer</h1>
      <p className="mt-1 text-sm text-muted">
        Requests go to the real API with the key you supply, so what you see here is what your code will get.
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Panel title="Request">
          <div className="flex gap-2">
            <select
              aria-label="Method"
              value={method}
              onChange={(event) => setMethod(event.target.value as Method)}
              className="rounded border border-edge bg-raised px-3 py-2 font-mono text-sm text-body"
            >
              {METHODS.map((entry) => <option key={entry}>{entry}</option>)}
            </select>
            <select
              aria-label="Table"
              value={table}
              onChange={(event) => setTable(event.target.value)}
              className="flex-1 rounded border border-edge bg-raised px-3 py-2 font-mono text-sm text-body"
            >
              <option value="">Choose a table…</option>
              {tables.data?.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
            </select>
          </div>

          <div className="mt-4">
            <Field label="Query string" hint="col=eq.value · order=col.desc · select=a,b · limit · offset">
              <Input value={queryString} onChange={(event) => setQueryString(event.target.value)} placeholder="active=eq.true&limit=10" />
            </Field>
          </div>

          <div className="mt-4">
            <Field label="API key" hint="Only prefixes are stored on the server, so paste the full key.">
              <Input value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="krs_anon_…" />
            </Field>
            {keys.data && keys.data.length > 0 ? (
              <p className="mt-2 font-mono text-xs text-muted">
                This project has: {keys.data.map((key) => `${key.kind} (${key.prefix}…)`).join(', ')}
              </p>
            ) : null}
          </div>

          {usingServiceRole ? (
            <div className="mt-4">
              <Alert>
                That is a service_role key. It bypasses every RLS policy, so this will not show you what your users
                would see. Use the anon key with an end-user token for that.
              </Alert>
            </div>
          ) : null}

          <div className="mt-4">
            <Field label="End-user token" hint="Optional. Populates auth.uid() so policies can identify the caller.">
              <Input value={userToken} onChange={(event) => setUserToken(event.target.value)} placeholder="eyJ…" />
            </Field>
          </div>

          {method === 'POST' || method === 'PATCH' ? (
            <div className="mt-4">
              <Field label="Body">
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  rows={8}
                  spellCheck={false}
                  className="w-full rounded border border-edge bg-raised px-3 py-2 font-mono text-xs text-body"
                />
              </Field>
            </div>
          ) : null}

          <div className="mt-5 flex items-center gap-3">
            <Button variant="primary" onClick={send} disabled={!table || !apiKey || running}>
              {running ? 'Sending…' : 'Send'}
            </Button>
            <code className="truncate font-mono text-xs text-muted">{method} {path}</code>
          </div>
        </Panel>

        <Panel title="Response">
          {!result ? (
            <p className="py-12 text-center text-sm text-muted">Nothing sent yet.</p>
          ) : (
            <>
              <div className="flex items-center gap-4 font-mono text-xs">
                <span className={result.status >= 400 || result.status === 0 ? 'text-coral' : 'text-mint'}>
                  {result.status === 0 ? 'network error' : result.status}
                </span>
                <span className="text-muted">{result.durationMs} ms (includes network)</span>
                {result.headers['content-range'] ? <span className="text-muted">range {result.headers['content-range']}</span> : null}
              </div>
              <pre className="mt-4 max-h-[26rem] overflow-auto rounded border border-edge bg-raised p-3 font-mono text-xs text-body">
                {result.body}
              </pre>
            </>
          )}
        </Panel>
      </div>

      <div className="mt-6">
        <Panel title="The same call, in code">
          <pre className="overflow-x-auto rounded border border-edge bg-raised p-3 font-mono text-xs text-body">
{`import { createClient } from '@kairosdb/client';

const db = createClient('${apiBase}', '${apiKey || 'YOUR_ANON_KEY'}');

const { data, error } = await db
  .from('${table || 'your_table'}')
  .select('*');`}
          </pre>
        </Panel>
      </div>
    </main>
  );
}
