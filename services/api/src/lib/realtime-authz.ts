/**
 * Realtime authorization.
 *
 * The bug this exists to fix: the WebSocket layer used to broadcast every
 * change on a subscribed table to every subscriber of that table. The
 * subscription carried `bypassRls` and `userId` and consulted neither. A
 * project could write a flawless `using (auth.uid() = user_id)` policy, have
 * REST honour it perfectly, and still leak every row over the socket.
 *
 * The fix is to ask PostgreSQL the same question REST asks it: *can this
 * identity see this row?* Not to reimplement policy evaluation in TypeScript —
 * that would be a second, subtly different implementation of the rules, which
 * is how you get a leak that only appears under the one policy nobody tested.
 *
 *   change event
 *        ↓
 *   primary key of the affected row
 *        ↓
 *   for each distinct subscriber identity:
 *        SET LOCAL request.jwt.claims = <that identity>
 *        SELECT EXISTS (SELECT 1 FROM tbl WHERE pk = ...)
 *        ↓
 *   visible? deliver : drop
 *
 * Two properties worth stating plainly:
 *
 *  - It **fails closed**. Anything this module cannot positively confirm is
 *    visible — unknown table, missing primary key, RLS that cannot be enforced
 *    on this connection, a database error — results in the event being dropped
 *    for RLS-bound subscribers. A dropped event is a bug report; a leaked row
 *    is an incident.
 *
 *  - It costs one query per (event × distinct identity), not per subscriber.
 *    Fifty sockets belonging to the same user are one check.
 */
import type { PoolClient } from 'pg';
import { poolManager } from '../db/pool-manager.js';
import { logger } from '../logger.js';
import { securityEvent } from './security-log.js';

export interface ChangeEvent {
  schema: string;
  table: string;
  type: 'INSERT' | 'UPDATE' | 'DELETE' | string;
  record?: Record<string, unknown> | undefined;
  old_record?: Record<string, unknown> | undefined;
}

export interface SubscriberIdentity {
  /** service_role keys legitimately bypass RLS, exactly as they do over REST. */
  bypassRls: boolean;
  userId: string | null;
  /** The verified claims from the project token, or null for anonymous. */
  claims: Record<string, unknown> | null;
}

interface TableMeta {
  primaryKey: string[];
  rlsEnabled: boolean;
  /**
   * True when RLS will actually apply to the pooled connection.
   *
   * PostgreSQL exempts a table's owner from its own policies unless the table
   * is set to FORCE ROW LEVEL SECURITY. The project's pooled role owns its
   * tables, so without FORCE the visibility probe would return true for every
   * row and this module would confidently authorise a leak.
   */
  rlsEnforceable: boolean;
}

/**
 * Cached per project+table. Invalidated on a timer rather than on DDL because
 * a stale entry only ever costs a re-check or a fail-closed drop, never a leak.
 */
const metaCache = new Map<string, { meta: TableMeta; at: number }>();
const META_TTL_MS = 30_000;

async function tableMeta(client: PoolClient, projectId: string, schema: string, table: string): Promise<TableMeta | null> {
  const cacheKey = `${projectId}:${schema}.${table}`;
  const cached = metaCache.get(cacheKey);
  if (cached && Date.now() - cached.at < META_TTL_MS) return cached.meta;

  const result = await client.query<{ column_name: string; relrowsecurity: boolean; relforcerowsecurity: boolean; is_owner: boolean }>(
    `SELECT a.attname AS column_name,
            c.relrowsecurity,
            c.relforcerowsecurity,
            pg_get_userbyid(c.relowner) = current_user AS is_owner
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
       LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, table],
  );

  if (result.rows.length === 0) return null;

  const first = result.rows[0]!;
  const meta: TableMeta = {
    primaryKey: result.rows.map((r) => r.column_name).filter((name): name is string => Boolean(name)),
    rlsEnabled: first.relrowsecurity,
    rlsEnforceable: first.relforcerowsecurity || !first.is_owner,
  };

  metaCache.set(cacheKey, { meta, at: Date.now() });
  return meta;
}

/** Drop cached metadata for a project, e.g. after DDL changes its tables. */
export function invalidateTableMeta(projectId: string): void {
  for (const key of metaCache.keys()) {
    if (key.startsWith(`${projectId}:`)) metaCache.delete(key);
  }
}

/**
 * Identities are grouped by a stable key so that N sockets sharing one
 * identity cost one probe. Anonymous subscribers all share the `anon` key.
 */
export function identityKey(identity: SubscriberIdentity): string {
  if (identity.bypassRls) return 'service_role';
  if (!identity.userId) return 'anon';
  return `user:${identity.userId}`;
}

function claimsFor(identity: SubscriberIdentity): string {
  const claims = identity.claims ?? (identity.userId ? { sub: identity.userId, role: 'authenticated' } : { role: 'anon' });
  return JSON.stringify(claims);
}

/**
 * Decide which identities may see the row this event describes.
 *
 * Returns a set of identity keys. An identity absent from the set must not
 * receive the event.
 */
export async function authorizeEvent(
  projectId: string,
  event: ChangeEvent,
  identities: Map<string, SubscriberIdentity>,
): Promise<Set<string>> {
  const allowed = new Set<string>();

  // service_role bypasses RLS here exactly as it does over REST. It is a
  // server-side credential; if it is in a browser, that is the leak, not this.
  for (const [key, identity] of identities) {
    if (identity.bypassRls) allowed.add(key);
  }

  const needChecking = [...identities.entries()].filter(([, identity]) => !identity.bypassRls);
  if (needChecking.length === 0) return allowed;

  // A DELETE removes the row, so visibility is judged on what it looked like
  // before. UPDATE uses the new row: a row the subscriber can no longer see
  // after the update should not be delivered to them.
  const row = event.type === 'DELETE' ? event.old_record : (event.record ?? event.old_record);
  if (!row) {
    logger.warn({ projectId, table: event.table }, 'realtime event carried no row — dropping for RLS subscribers');
    return allowed;
  }

  let client: PoolClient | undefined;
  try {
    const pool = await poolManager.get(projectId);
    client = await pool.connect();

    const meta = await tableMeta(client, projectId, event.schema, event.table);
    if (!meta) {
      logger.warn({ projectId, table: event.table }, 'realtime event for unknown table — dropping');
      return allowed;
    }

    // A table with RLS switched off has no row-level restriction to enforce;
    // anyone who may subscribe to the table may see its rows. That is the
    // project's decision, and the same one REST honours.
    if (!meta.rlsEnabled) {
      for (const [key] of needChecking) allowed.add(key);
      return allowed;
    }

    if (!meta.rlsEnforceable) {
      // The pooled role owns the table and the table is not FORCE RLS, so the
      // probe below would return true for every row. Refuse rather than
      // authorise on a check we know is meaningless.
      securityEvent('FORBIDDEN', {
        projectRef: projectId,
        detail: `realtime: ${event.schema}.${event.table} has RLS but not FORCE ROW LEVEL SECURITY — events dropped`,
      });
      logger.error(
        { projectId, table: `${event.schema}.${event.table}` },
        'RLS cannot be enforced for the pooled role; realtime events dropped. Run ALTER TABLE ... FORCE ROW LEVEL SECURITY.',
      );
      return allowed;
    }

    if (meta.primaryKey.length === 0) {
      logger.warn(
        { projectId, table: `${event.schema}.${event.table}` },
        'table has RLS but no primary key — realtime events cannot be authorized and are dropped',
      );
      return allowed;
    }

    // Build the identity probe once; only the claims change per identity.
    const pkValues = meta.primaryKey.map((column) => row[column]);
    if (pkValues.some((value) => value === undefined)) {
      logger.warn({ projectId, table: event.table }, 'realtime payload missing primary key columns — dropping');
      return allowed;
    }

    const predicate = meta.primaryKey
      .map((column, index) => `${quote(column)} = $${index + 1}`)
      .join(' AND ');
    const probe = `SELECT EXISTS (SELECT 1 FROM ${quote(event.schema)}.${quote(event.table)} WHERE ${predicate}) AS visible`;

    for (const [key, identity] of needChecking) {
      try {
        await client.query('BEGIN READ ONLY');
        // Same mechanism REST uses: claims arrive through a GUC the client
        // cannot write, and row_security stays on.
        await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claims', claimsFor(identity)]);
        await client.query('SET LOCAL row_security = on');
        const result = await client.query<{ visible: boolean }>(probe, pkValues);
        await client.query('COMMIT');
        if (result.rows[0]?.visible) allowed.add(key);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        logger.warn({ err: error, projectId, table: event.table, identity: key }, 'realtime visibility probe failed — dropping');
      }
    }
  } catch (error) {
    logger.error({ err: error, projectId }, 'realtime authorization unavailable — dropping event for RLS subscribers');
  } finally {
    client?.release();
  }

  return allowed;
}

/** Identifier quoting for the probe. Schema and table come from a trigger we wrote, but never interpolate unchecked. */
function quote(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(identifier)) {
    throw new Error(`Refusing to build a query with the identifier ${JSON.stringify(identifier)}`);
  }
  return `"${identifier}"`;
}
