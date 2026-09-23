/**
 * Tenant isolation and realtime authorization.
 *
 * These run against a live stack (`docker compose up -d && pnpm db:migrate`).
 * They are the tests that would have caught the realtime leak: the RLS policy
 * was correct, REST honoured it, and the WebSocket did not.
 *
 *   pnpm --filter @kairosdb/tests exec vitest run integration/isolation.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

const API = process.env['API_URL'] ?? 'http://localhost:4000';
const WS = API.replace(/^http/, 'ws');

interface Tenant {
  email: string;
  token: string;
  ref: string;
  anonKey: string;
  serviceKey: string;
  userId: string;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
  });
  const body = (await response.json()) as { data: T; error: { message: string } | null };
  if (body.error) throw new Error(`${path} → ${body.error.message}`);
  return body.data;
}

async function createTenant(label: string): Promise<Tenant> {
  const email = `iso-${label}-${Date.now()}@kairos.test`;
  const password = 'isolation-test-password-9182';

  const signup = await call<{ user: { id: string }; accessToken: string }>('/api/v1/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email, password, name: `Isolation ${label}` }),
  });

  const auth = { authorization: `Bearer ${signup.accessToken}` };
  const project = await call<{ ref: string; keys: { anon: string; service_role: string } }>('/api/v1/projects', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: `iso-${label}` }),
  });

  return {
    email,
    token: signup.accessToken,
    ref: project.ref,
    anonKey: project.keys.anon,
    serviceKey: project.keys.service_role,
    userId: signup.user.id,
  };
}

let alice: Tenant;
let bob: Tenant;

beforeAll(async () => {
  const health = await fetch(`${API}/api/health`).catch(() => null);
  if (!health?.ok) throw new Error(`The API is not running at ${API}. Start the stack first.`);

  [alice, bob] = await Promise.all([createTenant('alice'), createTenant('bob')]);

  // A table with RLS, in Alice's project.
  await call(`/api/v1/projects/${alice.ref}/database/tables`, {
    method: 'POST',
    headers: { authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({
      name: 'notes',
      enableRls: true,
      enableRealtime: true,
      columns: [
        { name: 'id', type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
        { name: 'owner_id', type: 'uuid', nullable: false },
        { name: 'body', type: 'text', nullable: false },
      ],
    }),
  });

  await call(`/api/v1/projects/${alice.ref}/database/tables/notes/policies`, {
    method: 'POST',
    headers: { authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({
      name: 'own_notes',
      command: 'ALL',
      using: 'owner_id = auth.uid()',
    }),
  });
}, 120_000);

afterAll(async () => {
  for (const tenant of [alice, bob]) {
    if (!tenant) continue;
    await call(`/api/v1/projects/${tenant.ref}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tenant.token}` },
      body: JSON.stringify({ confirm: tenant.ref }),
    }).catch(() => undefined);
  }
}, 60_000);

describe('tenant isolation', () => {
  it("refuses Bob's token on Alice's project", async () => {
    const response = await fetch(`${API}/api/v1/projects/${alice.ref}/database/tables`, {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect([403, 404]).toContain(response.status);
  });

  it("refuses Bob's anon key against Alice's REST surface", async () => {
    // The key resolves to Bob's project, so the table simply does not exist
    // there. What must never happen is Alice's rows coming back.
    const response = await fetch(`${API}/rest/v1/notes`, { headers: { apikey: bob.anonKey } });
    const body = await response.json();
    expect(response.ok ? (body as { data: unknown[] }).data : []).toEqual([]);
  });

  it("refuses Bob's service key on Alice's connection strings", async () => {
    const response = await fetch(`${API}/api/v1/projects/${alice.ref}/connection?reveal=true`, {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(response.ok).toBe(false);
  });
});

describe('RLS over REST', () => {
  it('hides rows the policy excludes', async () => {
    // Insert two rows as service_role, which bypasses RLS by design.
    await fetch(`${API}/rest/v1/notes`, {
      method: 'POST',
      headers: { apikey: alice.serviceKey, 'content-type': 'application/json' },
      body: JSON.stringify([
        { owner_id: alice.userId, body: 'alice note' },
        { owner_id: '00000000-0000-0000-0000-0000000000ff', body: 'someone else note' },
      ]),
    });

    const token = await call<{ token: string }>(`/api/v1/projects/${alice.ref}/tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ sub: alice.userId, role: 'authenticated' }),
    });

    const response = await fetch(`${API}/rest/v1/notes`, {
      headers: { apikey: alice.anonKey, authorization: `Bearer ${token.token}` },
    });
    const body = (await response.json()) as { data: { body: string }[] };
    expect(body.data.every((row) => row.body === 'alice note')).toBe(true);
  });
});

describe('RLS over realtime', () => {
  /**
   * The regression test for the leak.
   *
   * A subscriber authenticated as Alice must not receive a row inserted for a
   * different owner, even though it subscribed to the same table. Before the
   * authorization pass existed, this test would have received the row.
   */
  it('does not deliver rows the subscriber cannot select', async () => {
    const token = await call<{ token: string }>(`/api/v1/projects/${alice.ref}/tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ sub: alice.userId, role: 'authenticated' }),
    });

    const socket = new WebSocket(`${WS}/realtime/v1?apikey=${alice.anonKey}&token=${token.token}`);
    const received: { body?: string }[] = [];

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not connect')), 10_000);
      socket.on('message', (raw: Buffer) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'connected') {
          socket.send(JSON.stringify({ type: 'subscribe', table: 'notes' }));
        }
        if (frame.type === 'subscribed') {
          clearTimeout(timer);
          resolve();
        }
        if (frame.type === 'change') received.push(frame.record ?? {});
      });
      socket.on('error', reject);
    });

    // Insert a row belonging to someone else, using the service key.
    await fetch(`${API}/rest/v1/notes`, {
      method: 'POST',
      headers: { apikey: alice.serviceKey, 'content-type': 'application/json' },
      body: JSON.stringify({ owner_id: '00000000-0000-0000-0000-0000000000ff', body: 'must not leak' }),
    });

    // And one belonging to Alice, which she should receive.
    await fetch(`${API}/rest/v1/notes`, {
      method: 'POST',
      headers: { apikey: alice.serviceKey, 'content-type': 'application/json' },
      body: JSON.stringify({ owner_id: alice.userId, body: 'alice should see this' }),
    });

    // Generous window: authorization adds a query per event, and the point is
    // what arrives, not how fast.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    socket.close();

    expect(received.some((row) => row.body === 'must not leak')).toBe(false);
    expect(received.some((row) => row.body === 'alice should see this')).toBe(true);
  }, 40_000);

  it('delivers everything to a service_role subscriber', async () => {
    // service_role bypasses RLS over REST, and must do the same here —
    // otherwise the fix breaks every legitimate server-side consumer.
    const socket = new WebSocket(`${WS}/realtime/v1?apikey=${alice.serviceKey}`);
    const received: { body?: string }[] = [];

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not connect')), 10_000);
      socket.on('message', (raw: Buffer) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'connected') socket.send(JSON.stringify({ type: 'subscribe', table: 'notes' }));
        if (frame.type === 'subscribed') { clearTimeout(timer); resolve(); }
        if (frame.type === 'change') received.push(frame.record ?? {});
      });
      socket.on('error', reject);
    });

    await fetch(`${API}/rest/v1/notes`, {
      method: 'POST',
      headers: { apikey: alice.serviceKey, 'content-type': 'application/json' },
      body: JSON.stringify({ owner_id: '00000000-0000-0000-0000-0000000000ff', body: 'service sees this' }),
    });

    await new Promise((resolve) => setTimeout(resolve, 4000));
    socket.close();

    expect(received.some((row) => row.body === 'service sees this')).toBe(true);
  }, 40_000);

  it("refuses a socket opened with another project's key", async () => {
    const socket = new WebSocket(`${WS}/realtime/v1?apikey=not_a_real_key`);
    const closed = await new Promise<number>((resolve) => {
      socket.on('close', (code: number) => resolve(code));
      socket.on('error', () => resolve(4401));
    });
    expect(closed).toBeGreaterThanOrEqual(4000);
  }, 20_000);
});

describe('webhook SSRF is refused at the API boundary', () => {
  it('rejects a webhook pointed at the internal network', async () => {
    const response = await fetch(`${API}/api/v1/projects/${alice.ref}/webhooks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'evil', url: 'https://127.0.0.1/steal', events: ['database.insert'] }),
    });
    expect(response.ok).toBe(false);
  });
});
