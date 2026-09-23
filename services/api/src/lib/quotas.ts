/**
 * Per-project resource quotas.
 *
 * The platform runs on one machine that several projects share. Without
 * ceilings, the failure mode is not "one project degrades" — it is "one
 * project's bulk import fills the disk and every other project's writes start
 * failing", which is a far worse outage than refusing the import would have
 * been.
 *
 * Three enforcement strategies, chosen per resource:
 *
 *   live      counted at the moment of the request. Used where the check is
 *             cheap and the limit must not be crossed even briefly
 *             (max_file_bytes, max_connections).
 *   sampled   read from project_usage, refreshed by the usage worker. Used
 *             where an exact count is expensive (database size, storage
 *             bytes). A project can overshoot by whatever it writes between
 *             two samples — that is the stated trade, not an oversight.
 *   counter   a Redis window (api_requests_per_hour). Fast, shared across API
 *             instances, and lost on a Redis flush, which is acceptable for a
 *             rate ceiling.
 */
import { one, query } from '../db/platform.js';
import { redis } from './redis.js';
import { ApiError } from './errors.js';
import { logger } from '../logger.js';
import { env } from '../env.js';

export interface Quotas {
  database_bytes: string | null;
  storage_bytes: string | null;
  max_file_bytes: string | null;
  max_connections: number | null;
  max_tables: number | null;
  api_requests_per_hour: number | null;
  realtime_connections: number | null;
  background_jobs_per_day: number | null;
}

export interface Usage {
  database_bytes: string;
  storage_bytes: string;
  object_count: number;
  table_count: number;
  active_connections: number;
  sampled_at: string;
}

export type QuotaResource =
  | 'database_bytes'
  | 'storage_bytes'
  | 'max_file_bytes'
  | 'max_connections'
  | 'max_tables'
  | 'api_requests_per_hour'
  | 'realtime_connections'
  | 'background_jobs_per_day';

/**
 * Defaults, sized for a machine you can carry.
 *
 * Deliberately conservative: a project that needs more can be raised in one
 * row, whereas a project that quietly consumed 200 GB cannot be un-consumed.
 * Every value is overridable through the environment so the same code suits a
 * 8 GB laptop and a 128 GB server.
 */
export const DEFAULT_QUOTAS: Record<QuotaResource, number | null> = {
  database_bytes: Number(process.env['QUOTA_DATABASE_BYTES'] ?? 5 * 1024 ** 3),
  storage_bytes: Number(process.env['QUOTA_STORAGE_BYTES'] ?? 10 * 1024 ** 3),
  max_file_bytes: Number(process.env['QUOTA_MAX_FILE_BYTES'] ?? env.MAX_UPLOAD_BYTES),
  max_connections: Number(process.env['QUOTA_MAX_CONNECTIONS'] ?? 20),
  max_tables: Number(process.env['QUOTA_MAX_TABLES'] ?? 200),
  api_requests_per_hour: Number(process.env['QUOTA_API_REQUESTS_PER_HOUR'] ?? 100_000),
  realtime_connections: Number(process.env['QUOTA_REALTIME_CONNECTIONS'] ?? 50),
  background_jobs_per_day: Number(process.env['QUOTA_BACKGROUND_JOBS_PER_DAY'] ?? 500),
};

const HUMAN: Record<QuotaResource, string> = {
  database_bytes: 'database size',
  storage_bytes: 'file storage',
  max_file_bytes: 'file size',
  max_connections: 'database connections',
  max_tables: 'tables',
  api_requests_per_hour: 'API requests this hour',
  realtime_connections: 'realtime connections',
  background_jobs_per_day: 'background jobs today',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const BYTE_RESOURCES = new Set<QuotaResource>(['database_bytes', 'storage_bytes', 'max_file_bytes']);

/** Create the quota and usage rows for a newly provisioned project. */
export async function initialiseQuotas(projectId: string): Promise<void> {
  await query(
    `INSERT INTO project_quotas
       (project_id, database_bytes, storage_bytes, max_file_bytes, max_connections,
        max_tables, api_requests_per_hour, realtime_connections, background_jobs_per_day)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (project_id) DO NOTHING`,
    [
      projectId,
      DEFAULT_QUOTAS.database_bytes,
      DEFAULT_QUOTAS.storage_bytes,
      DEFAULT_QUOTAS.max_file_bytes,
      DEFAULT_QUOTAS.max_connections,
      DEFAULT_QUOTAS.max_tables,
      DEFAULT_QUOTAS.api_requests_per_hour,
      DEFAULT_QUOTAS.realtime_connections,
      DEFAULT_QUOTAS.background_jobs_per_day,
    ],
  );
  await query('INSERT INTO project_usage (project_id) VALUES ($1) ON CONFLICT (project_id) DO NOTHING', [projectId]);
}

/**
 * Quotas are read often and change rarely, so they are cached in Redis for a
 * minute. The cache is invalidated on write rather than only expiring, so an
 * operator raising a limit sees it take effect immediately rather than being
 * told to wait.
 */
const CACHE_TTL_SECONDS = 60;
const cacheKey = (projectId: string) => `quota:${projectId}`;

export async function getQuotas(projectId: string): Promise<Quotas> {
  const cached = await redis.get(cacheKey(projectId)).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached) as Quotas;
    } catch {
      // Corrupt cache entry: fall through and re-read from the database.
    }
  }

  const row = await one<Quotas>(
    `SELECT database_bytes::text, storage_bytes::text, max_file_bytes::text,
            max_connections, max_tables, api_requests_per_hour,
            realtime_connections, background_jobs_per_day
       FROM project_quotas WHERE project_id = $1`,
    [projectId],
  );

  // A project with no row predates this feature or was created by a code path
  // that forgot to initialise it. Fail closed onto the defaults rather than
  // treating a missing row as "unlimited".
  const quotas: Quotas = row ?? {
    database_bytes: String(DEFAULT_QUOTAS.database_bytes),
    storage_bytes: String(DEFAULT_QUOTAS.storage_bytes),
    max_file_bytes: String(DEFAULT_QUOTAS.max_file_bytes),
    max_connections: DEFAULT_QUOTAS.max_connections,
    max_tables: DEFAULT_QUOTAS.max_tables,
    api_requests_per_hour: DEFAULT_QUOTAS.api_requests_per_hour,
    realtime_connections: DEFAULT_QUOTAS.realtime_connections,
    background_jobs_per_day: DEFAULT_QUOTAS.background_jobs_per_day,
  };

  await redis.setex(cacheKey(projectId), CACHE_TTL_SECONDS, JSON.stringify(quotas)).catch(() => undefined);
  return quotas;
}

export async function invalidateQuotaCache(projectId: string): Promise<void> {
  await redis.del(cacheKey(projectId)).catch(() => undefined);
}

export async function getUsage(projectId: string): Promise<Usage> {
  const row = await one<Usage>(
    `SELECT database_bytes::text, storage_bytes::text, object_count,
            table_count, active_connections, sampled_at
       FROM project_usage WHERE project_id = $1`,
    [projectId],
  );
  return (
    row ?? {
      database_bytes: '0',
      storage_bytes: '0',
      object_count: 0,
      table_count: 0,
      active_connections: 0,
      sampled_at: new Date(0).toISOString(),
    }
  );
}

function limitOf(quotas: Quotas, resource: QuotaResource): number | null {
  const raw = quotas[resource];
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function recordViolation(projectId: string, resource: QuotaResource, limit: number, actual: number): Promise<void> {
  await query(
    'INSERT INTO quota_violations (project_id, resource, limit_value, actual) VALUES ($1,$2,$3,$4)',
    [projectId, resource, Math.round(limit), Math.round(actual)],
  ).catch((error: unknown) => {
    logger.warn({ err: error, projectId, resource }, 'could not record quota violation');
  });
}

/**
 * Throw if `attempted` would exceed the project's limit for `resource`.
 *
 * The error message names the limit and the current figure, because "quota
 * exceeded" with no numbers forces the developer to guess which resource and
 * by how much.
 */
export async function enforceQuota(
  projectId: string,
  resource: QuotaResource,
  attempted: number,
): Promise<void> {
  const quotas = await getQuotas(projectId);
  const limit = limitOf(quotas, resource);
  if (limit === null) return; // unlimited

  if (attempted > limit) {
    void recordViolation(projectId, resource, limit, attempted);
    const format = BYTE_RESOURCES.has(resource) ? formatBytes : (n: number) => String(n);
    throw new ApiError(
      'QUOTA_EXCEEDED',
      `This project's ${HUMAN[resource]} limit is ${format(limit)} and this would take it to ${format(attempted)}.`,
      { resource, limit, attempted },
    );
  }
}

/**
 * Sampled check: compare a stored figure plus the incoming delta.
 *
 * `sampled_at` is returned in the error detail so a developer who thinks the
 * number is wrong can see how stale it is rather than assuming the quota is
 * broken.
 */
export async function enforceSampledQuota(
  projectId: string,
  resource: 'database_bytes' | 'storage_bytes',
  additionalBytes: number,
): Promise<void> {
  const [quotas, usage] = await Promise.all([getQuotas(projectId), getUsage(projectId)]);
  const limit = limitOf(quotas, resource);
  if (limit === null) return;

  const current = Number(usage[resource]);
  const projected = current + additionalBytes;
  if (projected > limit) {
    void recordViolation(projectId, resource, limit, projected);
    throw new ApiError(
      'QUOTA_EXCEEDED',
      `This project's ${HUMAN[resource]} limit is ${formatBytes(limit)}. It is currently using ${formatBytes(current)}.`,
      { resource, limit, current, sampledAt: usage.sampled_at },
    );
  }
}

/**
 * Counter check: a fixed window in Redis.
 *
 * Fixed rather than sliding because a sliding window costs a sorted set per
 * project per resource, and for an hourly ceiling the boundary effect — up to
 * 2x the limit across a window edge — does not matter. It would matter for a
 * per-second limit, which is why the request rate limiter is a separate thing.
 */
export async function consumeQuotaCounter(
  projectId: string,
  resource: 'api_requests_per_hour' | 'background_jobs_per_day',
  amount = 1,
): Promise<void> {
  const quotas = await getQuotas(projectId);
  const limit = limitOf(quotas, resource);
  if (limit === null) return;

  const windowSeconds = resource === 'api_requests_per_hour' ? 3600 : 86_400;
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `quota:count:${resource}:${projectId}:${bucket}`;

  let used: number;
  try {
    used = await redis.incrby(key, amount);
    // Set the expiry only on the first write of the window; re-expiring on
    // every request would slide the window and it would never reset.
    if (used === amount) await redis.expire(key, windowSeconds + 60);
  } catch (error) {
    // Redis is down. Refusing every request because the counter is unavailable
    // turns a cache outage into a full outage, so this fails open and says so.
    logger.warn({ err: error, projectId, resource }, 'quota counter unavailable — allowing request');
    return;
  }

  if (used > limit) {
    void recordViolation(projectId, resource, limit, used);
    const retryAfter = (bucket + 1) * windowSeconds - Math.floor(Date.now() / 1000);
    throw new ApiError(
      'QUOTA_EXCEEDED',
      `This project has used its allowance of ${limit} ${HUMAN[resource]}. It resets in ${Math.ceil(retryAfter / 60)} minutes.`,
      { resource, limit, used, retryAfterSeconds: retryAfter },
    );
  }
}

/** Percentage of each limit currently consumed, for the dashboard. */
export function summarise(quotas: Quotas, usage: Usage) {
  const entry = (resource: QuotaResource, used: number) => {
    const limit = limitOf(quotas, resource);
    return {
      resource,
      label: HUMAN[resource],
      used,
      limit,
      percent: limit && limit > 0 ? Number(((used / limit) * 100).toFixed(1)) : null,
      unlimited: limit === null,
    };
  };

  return [
    entry('database_bytes', Number(usage.database_bytes)),
    entry('storage_bytes', Number(usage.storage_bytes)),
    entry('max_tables', usage.table_count),
    entry('max_connections', usage.active_connections),
  ];
}
