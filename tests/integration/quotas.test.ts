/**
 * Quota unit tests.
 *
 * These exercise the decision logic — what counts as over the line, how a
 * missing row is treated, what happens when Redis is unavailable — without a
 * database or a Redis instance, by stubbing the two modules quotas.ts reads
 * from. The integration suite covers the wiring.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const platform = vi.hoisted(() => ({
  one: vi.fn(),
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

const redisStub = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue(null),
  setex: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  incrby: vi.fn(),
  expire: vi.fn().mockResolvedValue(1),
}));

vi.mock('../../services/api/src/db/platform.js', () => platform);
vi.mock('../../services/api/src/lib/redis.js', () => ({ redis: redisStub }));
vi.mock('../../services/api/src/env.js', () => ({
  env: { MAX_UPLOAD_BYTES: 50 * 1024 * 1024 },
}));
vi.mock('../../services/api/src/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const {
  enforceQuota,
  enforceSampledQuota,
  consumeQuotaCounter,
  getQuotas,
  summarise,
} = await import('../../services/api/src/lib/quotas.js');

const PROJECT = '00000000-0000-0000-0000-000000000001';

const quotaRow = (overrides: Record<string, unknown> = {}) => ({
  database_bytes: '1000',
  storage_bytes: '2000',
  max_file_bytes: '500',
  max_connections: 10,
  max_tables: 5,
  api_requests_per_hour: 100,
  realtime_connections: 20,
  background_jobs_per_day: 50,
  ...overrides,
});

const usageRow = (overrides: Record<string, unknown> = {}) => ({
  database_bytes: '0',
  storage_bytes: '0',
  object_count: 0,
  table_count: 0,
  active_connections: 0,
  sampled_at: new Date().toISOString(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  redisStub.get.mockResolvedValue(null);
});

describe('enforceQuota', () => {
  it('allows a value at exactly the limit', async () => {
    platform.one.mockResolvedValueOnce(quotaRow());
    await expect(enforceQuota(PROJECT, 'max_tables', 5)).resolves.toBeUndefined();
  });

  it('rejects one past the limit', async () => {
    platform.one.mockResolvedValueOnce(quotaRow());
    await expect(enforceQuota(PROJECT, 'max_tables', 6)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      status: 413,
    });
  });

  it('treats null as unlimited', async () => {
    platform.one.mockResolvedValueOnce(quotaRow({ max_tables: null }));
    await expect(enforceQuota(PROJECT, 'max_tables', 10_000)).resolves.toBeUndefined();
  });

  it('treats zero as blocked rather than unlimited', async () => {
    // A real distinction: zero is how a project gets suspended without being
    // deleted, and confusing it with null would silently un-suspend it.
    platform.one.mockResolvedValueOnce(quotaRow({ max_tables: 0 }));
    await expect(enforceQuota(PROJECT, 'max_tables', 1)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('names the resource and both numbers in the error', async () => {
    platform.one.mockResolvedValueOnce(quotaRow());
    await expect(enforceQuota(PROJECT, 'max_tables', 9)).rejects.toMatchObject({
      details: { resource: 'max_tables', limit: 5, attempted: 9 },
    });
  });

  it('records a violation row when it refuses', async () => {
    platform.one.mockResolvedValueOnce(quotaRow());
    await expect(enforceQuota(PROJECT, 'max_tables', 6)).rejects.toThrow();
    // Fire-and-forget, so let the microtask queue drain before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    expect(platform.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO quota_violations'),
      [PROJECT, 'max_tables', 5, 6],
    );
  });
});

describe('getQuotas', () => {
  it('falls back to defaults when a project has no quota row', async () => {
    // Fail closed. Treating a missing row as "unlimited" would hand any
    // project created by a path that forgot to initialise it the whole machine.
    platform.one.mockResolvedValueOnce(null);
    const quotas = await getQuotas(PROJECT);
    expect(quotas.max_tables).toBeGreaterThan(0);
    expect(quotas.database_bytes).not.toBeNull();
  });

  it('serves a cached value without touching the database', async () => {
    redisStub.get.mockResolvedValueOnce(JSON.stringify(quotaRow()));
    const quotas = await getQuotas(PROJECT);
    expect(quotas.max_tables).toBe(5);
    expect(platform.one).not.toHaveBeenCalled();
  });

  it('re-reads from the database when the cache entry is corrupt', async () => {
    redisStub.get.mockResolvedValueOnce('{not json');
    platform.one.mockResolvedValueOnce(quotaRow({ max_tables: 7 }));
    const quotas = await getQuotas(PROJECT);
    expect(quotas.max_tables).toBe(7);
  });
});

describe('enforceSampledQuota', () => {
  it('adds the incoming delta to the sampled figure', async () => {
    platform.one
      .mockResolvedValueOnce(quotaRow({ storage_bytes: '1000' }))
      .mockResolvedValueOnce(usageRow({ storage_bytes: '900' }));
    await expect(enforceSampledQuota(PROJECT, 'storage_bytes', 200)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
  });

  it('allows a write that still fits', async () => {
    platform.one
      .mockResolvedValueOnce(quotaRow({ storage_bytes: '1000' }))
      .mockResolvedValueOnce(usageRow({ storage_bytes: '500' }));
    await expect(enforceSampledQuota(PROJECT, 'storage_bytes', 100)).resolves.toBeUndefined();
  });

  it('reports how stale the sample is, so a surprising number can be explained', async () => {
    const sampledAt = new Date(Date.now() - 600_000).toISOString();
    platform.one
      .mockResolvedValueOnce(quotaRow({ storage_bytes: '100' }))
      .mockResolvedValueOnce(usageRow({ storage_bytes: '99', sampled_at: sampledAt }));
    await expect(enforceSampledQuota(PROJECT, 'storage_bytes', 50)).rejects.toMatchObject({
      details: { sampledAt },
    });
  });
});

describe('consumeQuotaCounter', () => {
  it('sets an expiry only on the first increment of a window', async () => {
    platform.one.mockResolvedValue(quotaRow());
    redisStub.incrby.mockResolvedValueOnce(1);
    await consumeQuotaCounter(PROJECT, 'api_requests_per_hour');
    expect(redisStub.expire).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    redisStub.get.mockResolvedValue(null);
    platform.one.mockResolvedValue(quotaRow());
    redisStub.incrby.mockResolvedValueOnce(2);
    await consumeQuotaCounter(PROJECT, 'api_requests_per_hour');
    // Re-expiring on every request would slide the window and it would never
    // reset, which is the classic way this bug ships unnoticed.
    expect(redisStub.expire).not.toHaveBeenCalled();
  });

  it('rejects once the count passes the limit', async () => {
    platform.one.mockResolvedValue(quotaRow({ api_requests_per_hour: 10 }));
    redisStub.incrby.mockResolvedValueOnce(11);
    await expect(consumeQuotaCounter(PROJECT, 'api_requests_per_hour')).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
  });

  it('fails open when Redis is unavailable', async () => {
    // A cache outage should not become a full outage. Deliberate, and the
    // reason there is a log line at the call site.
    platform.one.mockResolvedValue(quotaRow());
    redisStub.incrby.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(consumeQuotaCounter(PROJECT, 'api_requests_per_hour')).resolves.toBeUndefined();
  });
});

describe('summarise', () => {
  it('computes percentages and marks unlimited resources', () => {
    const summary = summarise(
      quotaRow({ database_bytes: '1000', max_tables: null }) as never,
      usageRow({ database_bytes: '250', table_count: 3 }) as never,
    );
    const database = summary.find((entry) => entry.resource === 'database_bytes');
    const tables = summary.find((entry) => entry.resource === 'max_tables');
    expect(database?.percent).toBe(25);
    expect(tables?.unlimited).toBe(true);
    expect(tables?.percent).toBeNull();
  });
});
