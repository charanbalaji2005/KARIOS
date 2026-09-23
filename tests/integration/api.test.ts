/**
 * End-to-end pass over the whole stack. Requires a running environment:
 *   docker compose up -d && pnpm db:migrate
 *
 * Run with:  API_URL=http://localhost:4000 pnpm --filter @kairosdb/tests test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:4000';
const email = `test-${Date.now()}@kairosdb.local`;
const password = 'test-password-12345';

let accessToken = '';
let organizationId = '';
let projectId = '';
let projectRef = '';
let anonKey = '';
let serviceKey = '';

async function call<T>(path: string, init: RequestInit = {}, token = accessToken): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string>),
    },
  });
  const body = (await response.json()) as { data: T; error: { message: string } | null };
  if (body.error) throw new Error(`${path}: ${body.error.message}`);
  return body.data;
}

describe('KairosDB platform', () => {
  beforeAll(async () => {
    const health = await call<{ status: string }>('/api/health', {}, '');
    expect(health.status).toBe('healthy');
  });

  it('signs a user up and returns a working session', async () => {
    const data = await call<{ accessToken: string; organizationId: string }>('/api/v1/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password, fullName: 'Test User' }),
    }, '');
    accessToken = data.accessToken;
    organizationId = data.organizationId;
    expect(accessToken).toBeTruthy();

    const me = await call<{ user: { email: string } }>('/api/v1/auth/me');
    expect(me.user.email).toBe(email);
  });

  it('rejects a duplicate signup', async () => {
    await expect(
      call('/api/v1/auth/signup', { method: 'POST', body: JSON.stringify({ email, password }) }, ''),
    ).rejects.toThrow(/already exists/i);
  });

  it('provisions a project with a real database and keys', async () => {
    const project = await call<{ id: string; ref: string; keys: { anon: string; serviceRole: string } }>('/api/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test Project', organizationId }),
    });
    projectId = project.id;
    projectRef = project.ref;
    anonKey = project.keys.anon;
    serviceKey = project.keys.serviceRole;
    expect(projectRef).toMatch(/^[a-z]{12}$/);
  }, 60_000);

  it('creates a table through the DDL API', async () => {
    const result = await call<{ sql: string }>(`/api/v1/projects/${projectId}/database/tables`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'items',
        columns: [
          { name: 'id', type: 'uuid', primaryKey: true, nullable: false, default: 'gen_random_uuid()' },
          { name: 'title', type: 'text', nullable: false },
          { name: 'done', type: 'boolean', nullable: false, default: 'false' },
        ],
        enableRls: false,
        enableRealtime: true,
      }),
    });
    expect(result.sql).toContain('CREATE TABLE');

    const tables = await call<{ name: string }[]>(`/api/v1/projects/${projectId}/database/tables`);
    expect(tables.map((t) => t.name)).toContain('items');
  });

  it('refuses an injection attempt in an identifier', async () => {
    await expect(
      call(`/api/v1/projects/${projectId}/database/tables`, {
        method: 'POST',
        body: JSON.stringify({ name: 'x"; DROP TABLE items; --', columns: [{ name: 'a', type: 'text' }] }),
      }),
    ).rejects.toThrow();

    const tables = await call<{ name: string }[]>(`/api/v1/projects/${projectId}/database/tables`);
    expect(tables.map((t) => t.name)).toContain('items');
  });

  it('runs SQL and records it in the query log', async () => {
    const result = await call<{ rows: unknown[]; durationMs: number }>(`/api/v1/projects/${projectId}/sql`, {
      method: 'POST',
      body: JSON.stringify({ query: 'select 1 as answer' }),
    });
    expect(result.rows).toEqual([{ answer: 1 }]);

    const history = await call<unknown[]>(`/api/v1/projects/${projectId}/sql/history?limit=5`);
    expect(history.length).toBeGreaterThan(0);
  });

  it('serves the auto-generated REST API with an API key', async () => {
    const created = await fetch(`${API}/rest/v1/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: serviceKey },
      body: JSON.stringify({ title: 'first item' }),
    }).then((r) => r.json());
    expect(created.data[0].title).toBe('first item');

    const listed = await fetch(`${API}/rest/v1/items?title=eq.first%20item`, {
      headers: { apikey: serviceKey },
    }).then((r) => r.json());
    expect(listed.data).toHaveLength(1);
  });

  it('rejects an invalid API key', async () => {
    const response = await fetch(`${API}/rest/v1/items`, { headers: { apikey: 'krs_anon_not_a_real_key' } });
    expect(response.status).toBe(401);
  });

  it('refuses an unfiltered delete', async () => {
    const response = await fetch(`${API}/rest/v1/items`, { method: 'DELETE', headers: { apikey: serviceKey } });
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('creates a bucket and blocks path traversal', async () => {
    await call(`/api/v1/projects/${projectId}/storage/buckets`, {
      method: 'POST',
      body: JSON.stringify({ name: 'uploads', public: false }),
    });

    await expect(
      call(`/api/v1/projects/${projectId}/storage/buckets/uploads/signed-url`, {
        method: 'POST',
        body: JSON.stringify({ path: '../../../../etc/passwd' }),
      }),
    ).rejects.toThrow(/\.\./);
  });

  it('generates TypeScript types from the live schema', async () => {
    const response = await fetch(`${API}/api/v1/projects/${projectId}/types`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const types = await response.text();
    expect(types).toContain('items: {');
    expect(types).toContain('title: string');
  });

  afterAll(async () => {
    if (projectId) {
      await call(`/api/v1/projects/${projectId}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm: projectRef }),
      }).catch(() => undefined);
    }
  });
});
