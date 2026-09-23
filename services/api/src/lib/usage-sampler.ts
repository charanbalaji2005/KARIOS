/**
 * Usage sampler.
 *
 * Quota enforcement for the expensive resources reads `project_usage` rather
 * than counting on demand. This is what keeps that table honest.
 *
 * Runs on a timer in the worker process, not the API: walking a filesystem or
 * calling `pg_database_size` across every project is exactly the kind of work
 * that should never sit in a request path.
 */
import { many, one, query } from '../db/platform.js';
import { poolManager } from '../db/pool-manager.js';
import { storage } from './storage/index.js';
import { logger } from '../logger.js';

export interface SampledUsage {
  databaseBytes: number;
  storageBytes: number;
  objectCount: number;
  tableCount: number;
  activeConnections: number;
}

/**
 * Sample one project and write the result.
 *
 * Every measurement is taken independently and a failure in one does not
 * discard the others — a project whose database is unreachable should still
 * get an accurate storage figure, not a row of zeroes that would read as
 * "using nothing" and disable its quotas entirely.
 */
export async function sampleProjectUsage(projectId: string, projectRef: string): Promise<SampledUsage> {
  const previous = await one<{ database_bytes: string; storage_bytes: string; object_count: number; table_count: number }>(
    'SELECT database_bytes::text, storage_bytes::text, object_count, table_count FROM project_usage WHERE project_id = $1',
    [projectId],
  );

  // Fall back to the previous reading rather than zero. A transient failure
  // that resets usage to 0 would silently hand the project unlimited headroom
  // until the next successful sample.
  let databaseBytes = Number(previous?.database_bytes ?? 0);
  let tableCount = previous?.table_count ?? 0;
  let activeConnections = 0;

  try {
    const pool = await poolManager.get(projectId);
    const [size, tables, connections] = await Promise.all([
      pool.query<{ bytes: string }>('SELECT pg_database_size(current_database())::text AS bytes'),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog','information_schema','auth')
            AND table_type = 'BASE TABLE'`,
      ),
      pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM pg_stat_activity WHERE datname = current_database()',
      ),
    ]);
    databaseBytes = Number(size.rows[0]?.bytes ?? databaseBytes);
    tableCount = Number(tables.rows[0]?.count ?? tableCount);
    activeConnections = Number(connections.rows[0]?.count ?? 0);
  } catch (error) {
    logger.warn({ err: error, projectId }, 'could not sample database usage — keeping previous figure');
  }

  let storageBytes = Number(previous?.storage_bytes ?? 0);
  try {
    storageBytes = await storage.usage(projectRef);
  } catch (error) {
    logger.warn({ err: error, projectId }, 'could not sample storage usage — keeping previous figure');
  }

  // Object count comes from the metadata table, which is authoritative and
  // costs one indexed query, rather than from listing the store.
  const objects = await one<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM storage_objects o
       JOIN storage_buckets b ON b.id = o.bucket_id
      WHERE b.project_id = $1`,
    [projectId],
  ).catch(() => null);
  const objectCount = Number(objects?.count ?? previous?.object_count ?? 0);

  await query(
    `INSERT INTO project_usage
       (project_id, database_bytes, storage_bytes, object_count, table_count, active_connections, sampled_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (project_id) DO UPDATE SET
       database_bytes     = EXCLUDED.database_bytes,
       storage_bytes      = EXCLUDED.storage_bytes,
       object_count       = EXCLUDED.object_count,
       table_count        = EXCLUDED.table_count,
       active_connections = EXCLUDED.active_connections,
       sampled_at         = NOW()`,
    [projectId, databaseBytes, storageBytes, objectCount, tableCount, activeConnections],
  );

  // Keep a time series too, so the dashboard can show growth rather than only
  // a current figure. "You are at 80%" is less useful than "you were at 20%
  // last week", which is the difference between a warning and a forecast.
  await query(
    `INSERT INTO usage_metrics (project_id, metric, value) VALUES
       ($1,'database_bytes',$2), ($1,'storage_bytes',$3), ($1,'table_count',$4)`,
    [projectId, databaseBytes, storageBytes, tableCount],
  ).catch(() => undefined);

  return { databaseBytes, storageBytes, objectCount, tableCount, activeConnections };
}

/** Sample every active project. Called on a timer by the worker. */
export async function sampleAllProjects(): Promise<{ sampled: number; failed: number }> {
  const projects = await many<{ id: string; ref: string }>(
    `SELECT id, ref FROM projects WHERE deleted_at IS NULL AND status = 'active'`,
  );

  let sampled = 0;
  let failed = 0;
  // Sequential on purpose. Sampling in parallel would open a connection to
  // every project database at once, which on a laptop is how the sampler
  // becomes the thing that exhausts max_connections.
  for (const project of projects) {
    try {
      await sampleProjectUsage(project.id, project.ref);
      sampled += 1;
    } catch (error) {
      failed += 1;
      logger.error({ err: error, projectId: project.id }, 'usage sample failed');
    }
  }

  logger.info({ sampled, failed }, 'usage sampling complete');
  return { sampled, failed };
}
