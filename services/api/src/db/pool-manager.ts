import pg from 'pg';
import { decrypt } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { logger } from '../logger.js';
import { one } from './platform.js';

const { Pool } = pg;

/**
 * Global connection budget.
 *
 * The old code gave every project a pool of `max: 10` with no ceiling on the
 * number of pools. Thirty active projects is 300 connections, which is exactly
 * PostgreSQL's `max_connections` — leaving nothing for the platform database,
 * the realtime LISTEN clients, the workers, or a human with psql. The failure
 * is not graceful: the next connection attempt from *anything* is refused, and
 * the thing refused is usually the monitoring that would have told you why.
 *
 * So the budget is explicit. A reserve is held back for platform use, the
 * remainder is shared between project pools, and each project's slice shrinks
 * as more projects become active rather than being a fixed number that only
 * works below some unstated project count.
 */
const TOTAL_BUDGET = Number(process.env['PG_CONNECTION_BUDGET'] ?? 300);
/** Platform pool, realtime listeners, workers, and headroom for an operator. */
const PLATFORM_RESERVE = Number(process.env['PG_PLATFORM_RESERVE'] ?? 60);
const PROJECT_BUDGET = Math.max(10, TOTAL_BUDGET - PLATFORM_RESERVE);
/** Never below this, or a busy project cannot serve a single request. */
const MIN_PER_PROJECT = Number(process.env['PG_MIN_POOL'] ?? 2);
const MAX_PER_PROJECT = Number(process.env['PG_MAX_POOL'] ?? 10);

interface ConnectionRow {
  host: string;
  port: number;
  db_name: string;
  db_user: string;
  password_enc: string;
}

export interface ProjectConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

interface Entry {
  pool: pg.Pool;
  lastUsed: number;
  /** The slice this pool was given, so the budget can be summed without asking pg. */
  max: number;
}

/**
 * Per-project connection pools, cached and reaped. Without this, every request
 * to a project's REST API would open a fresh Postgres connection and the
 * database would run out of slots under trivial load.
 */
class PoolManager {
  private pools = new Map<string, Entry>();
  private readonly idleMs = 5 * 60 * 1000;
  private reaper: NodeJS.Timeout;

  /**
   * How many connections this project's pool may hold, given how many projects
   * are currently active and what the project's own quota allows.
   *
   * Recomputed rather than fixed: pool 31 opening should not be the moment the
   * database runs out, it should be the moment every pool gets a little
   * smaller.
   */
  private sliceFor(activePools: number, quotaMax: number | null): number {
    const fairShare = Math.floor(PROJECT_BUDGET / Math.max(1, activePools));
    const ceiling = quotaMax === null ? MAX_PER_PROJECT : Math.min(MAX_PER_PROJECT, quotaMax);
    return Math.max(MIN_PER_PROJECT, Math.min(ceiling, fairShare));
  }

  /** Connections currently allocated across every project pool. */
  allocated(): number {
    let total = 0;
    for (const entry of this.pools.values()) total += entry.max;
    return total;
  }

  stats() {
    return {
      totalBudget: TOTAL_BUDGET,
      platformReserve: PLATFORM_RESERVE,
      projectBudget: PROJECT_BUDGET,
      pools: this.pools.size,
      allocated: this.allocated(),
      perPool: [...this.pools.entries()].map(([projectId, entry]) => ({
        projectId,
        max: entry.max,
        idle: entry.pool.idleCount,
        waiting: entry.pool.waitingCount,
        total: entry.pool.totalCount,
      })),
    };
  }

  constructor() {
    this.reaper = setInterval(() => this.reap(), 60_000);
    this.reaper.unref?.();
  }

  async credentials(projectId: string): Promise<ProjectConnection> {
    const row = await one<ConnectionRow>(
      `SELECT host, port, db_name, db_user, password_enc
         FROM database_connections WHERE project_id = $1`,
      [projectId],
    );
    if (!row) throw new ApiError('PROJECT_NOT_FOUND', 'This project has no provisioned database yet');
    return {
      host: row.host,
      port: row.port,
      database: row.db_name,
      user: row.db_user,
      password: decrypt(row.password_enc),
    };
  }

  async get(projectId: string): Promise<pg.Pool> {
    const cached = this.pools.get(projectId);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached.pool;
    }

    const creds = await this.credentials(projectId);

    // The project's own quota is an upper bound on its slice; the global
    // budget is the other. Whichever is smaller wins.
    let quotaMax: number | null = null;
    try {
      const quotaRow = await one<{ max_connections: number | null }>(
        'SELECT max_connections FROM project_quotas WHERE project_id = $1',
        [projectId],
      );
      quotaMax = quotaRow?.max_connections ?? null;
    } catch {
      // Quotas unavailable: fall back to the global budget alone rather than
      // refusing to open a pool at all.
    }

    const max = this.sliceFor(this.pools.size + 1, quotaMax);

    if (this.allocated() + max > PROJECT_BUDGET) {
      // Reclaim idle pools before refusing. On a laptop the common case is a
      // dozen projects that were touched once and never again.
      this.reap(true);
    }
    if (this.allocated() + max > PROJECT_BUDGET) {
      logger.error(
        { projectId, allocated: this.allocated(), budget: PROJECT_BUDGET },
        'connection budget exhausted — refusing to open another project pool',
      );
      throw new ApiError(
        'DATABASE_ERROR',
        'This server has no spare database connections right now. Try again shortly.',
      );
    }

    const pool = new Pool({
      ...creds,
      max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: `kairosdb-project-${projectId.slice(0, 8)}`,
    });
    pool.on('error', (err) => logger.error({ err, projectId }, 'Project pool error'));

    this.pools.set(projectId, { pool, lastUsed: Date.now(), max });
    logger.debug({ projectId, max, allocated: this.allocated(), budget: PROJECT_BUDGET }, 'project pool opened');
    return pool;
  }

  async evict(projectId: string): Promise<void> {
    const entry = this.pools.get(projectId);
    if (!entry) return;
    this.pools.delete(projectId);
    await entry.pool.end().catch(() => undefined);
  }

  /**
   * Close pools nobody has used lately. `aggressive` shortens the idle window,
   * used when the budget is under pressure and a pool that has been quiet for
   * thirty seconds is worth more as free capacity than as a warm cache.
   */
  private reap(aggressive = false): void {
    const cutoff = Date.now() - (aggressive ? 30_000 : this.idleMs);
    for (const [id, entry] of this.pools) {
      if (entry.lastUsed < cutoff) {
        this.pools.delete(id);
        entry.pool.end().catch(() => undefined);
      }
    }
  }

  async closeAll(): Promise<void> {
    clearInterval(this.reaper);
    await Promise.all([...this.pools.values()].map((e) => e.pool.end().catch(() => undefined)));
    this.pools.clear();
  }
}

export const poolManager = new PoolManager();
