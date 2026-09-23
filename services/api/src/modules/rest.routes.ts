import { consumeQuotaCounter } from '../lib/quotas.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { one } from '../db/platform.js';
import { poolManager } from '../db/pool-manager.js';
import { decrypt } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { verifyProjectToken } from '../lib/jwt.js';
import { consume, RULES } from '../lib/rate-limit.js';
import { quoteIdent, quoteQualified } from '../lib/sql.js';
import { publishEvent } from './events.js';

/** PostgREST-compatible operator vocabulary: ?age=gte.18&name=like.*ali* */
const OPERATORS: Record<string, string> = {
  eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=',
  like: 'LIKE', ilike: 'ILIKE', is: 'IS', in: 'IN', cs: '@>', cd: '<@',
};

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'page', 'cursor', 'count']);

interface Filter { sql: string; values: unknown[] }

function buildFilters(query: Record<string, unknown>, startIndex: number): Filter {
  const clauses: string[] = [];
  const values: unknown[] = [];
  let index = startIndex;

  for (const [rawKey, rawValue] of Object.entries(query)) {
    if (RESERVED.has(rawKey) || typeof rawValue !== 'string') continue;
    const column = quoteIdent(rawKey);
    const separator = rawValue.indexOf('.');
    const op = separator === -1 ? 'eq' : rawValue.slice(0, separator);
    const operand = separator === -1 ? rawValue : rawValue.slice(separator + 1);

    const sqlOp = OPERATORS[op];
    if (!sqlOp) throw new ApiError('VALIDATION_ERROR', `Unknown filter operator "${op}" on ${rawKey}`);

    if (op === 'is') {
      const normalized = operand.toLowerCase();
      if (!['null', 'not.null', 'true', 'false'].includes(normalized)) {
        throw new ApiError('VALIDATION_ERROR', `is. accepts null, not.null, true or false`);
      }
      clauses.push(`${column} IS ${normalized === 'not.null' ? 'NOT NULL' : normalized.toUpperCase()}`);
      continue;
    }

    if (op === 'in') {
      const items = operand.replace(/^\(|\)$/g, '').split(',').filter(Boolean);
      if (items.length === 0) throw new ApiError('VALIDATION_ERROR', `in. needs at least one value`);
      clauses.push(`${column} IN (${items.map(() => `$${index++}`).join(', ')})`);
      values.push(...items);
      continue;
    }

    // `*` is the wildcard in the query string, translated to SQL's `%`.
    const value = op === 'like' || op === 'ilike' ? operand.replace(/\*/g, '%') : operand;
    clauses.push(`${column} ${sqlOp} $${index++}`);
    values.push(value);
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

function buildSelect(select?: string): string {
  if (!select || select.trim() === '*') return '*';
  return select.split(',').map((c) => quoteIdent(c.trim())).join(', ');
}

function buildOrder(order?: string): string {
  if (!order) return '';
  const parts = order.split(',').map((piece) => {
    const [column, ...modifiers] = piece.trim().split('.');
    const direction = modifiers.includes('desc') ? 'DESC' : 'ASC';
    const nulls = modifiers.includes('nullsfirst') ? ' NULLS FIRST' : modifiers.includes('nullslast') ? ' NULLS LAST' : '';
    return `${quoteIdent(column!.trim())} ${direction}${nulls}`;
  });
  return `ORDER BY ${parts.join(', ')}`;
}

/**
 * Runs the statement with the caller's identity attached, so RLS policies and
 * auth.uid() behave exactly as they would for a direct connection.
 *
 * anon / end-user tokens  -> role `kairos_anon`, claims set, RLS enforced.
 * service_role keys       -> owner role, RLS bypassed. Server-side only.
 */
async function withIdentity<T>(
  client: PoolClient,
  identity: { claims: Record<string, unknown> | null; bypassRls: boolean },
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify(identity.claims ?? {}),
    ]);
    if (!identity.bypassRls) {
      // Row security applies to the table owner only when forced on; setting a
      // non-owner role is what actually makes policies bite.
      await client.query(`SET LOCAL row_security = on`);
    }
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/** Resolves the end-user identity carried alongside an API key, if any. */
async function resolveIdentity(req: FastifyRequest): Promise<{ claims: Record<string, unknown> | null; bypassRls: boolean }> {
  const apiKey = req.apiKey!;
  if (apiKey.kind === 'service_role') return { claims: { role: 'service_role' }, bypassRls: true };

  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  // A bare anon key with no user token is an anonymous caller.
  if (!token || token === (req.headers['apikey'] as string | undefined)) {
    return { claims: { role: 'anon' }, bypassRls: false };
  }

  const project = await one<{ jwt_secret_enc: string; ref: string }>(
    'SELECT jwt_secret_enc, ref FROM projects WHERE id = $1',
    [apiKey.projectId],
  );
  if (!project?.jwt_secret_enc) throw new ApiError('INTERNAL_ERROR', 'Project signing key missing');

  const claims = await verifyProjectToken(decrypt(project.jwt_secret_enc), project.ref, token);
  return { claims: { ...claims, role: claims.role ?? 'authenticated' }, bypassRls: false };
}

export default async function restRoutes(app: FastifyInstance) {
  /**
   * Every auto-REST call is counted against the project's hourly allowance.
   *
   * This is a project-level ceiling, distinct from the per-IP rate limiter in
   * nginx and the per-key limiter in lib/rate-limit.ts. Those stop one client
   * hammering the server; this stops one project consuming the whole machine's
   * capacity across a hundred well-behaved clients.
   */
  const countRequest = async (req: FastifyRequest) => {
    if (req.apiKey) await consumeQuotaCounter(req.apiKey.projectId, 'api_requests_per_hour');
  };

  const guard = { preHandler: [app.requireApiKey, countRequest] };

  app.get('/rest/v1/:table', guard, async (req, reply) => {
    await consume('rest', req.apiKey!.projectId, RULES.api);
    const { table } = z.object({ table: z.string().min(1) }).parse(req.params);
    const q = req.query as Record<string, string | undefined>;

    const schema = q['schema'] ?? 'public';
    const limit = Math.min(Number(q['limit'] ?? 50) || 50, 1000);
    const offset = Math.max(Number(q['offset'] ?? 0) || 0, 0);
    const filters = buildFilters(q, 1);

    const sql = [
      `SELECT ${buildSelect(q['select'])} FROM ${quoteQualified(schema, table)}`,
      filters.sql,
      buildOrder(q['order']),
      `LIMIT ${limit} OFFSET ${offset}`,
    ].filter(Boolean).join(' ');

    const identity = await resolveIdentity(req);
    const pool = await poolManager.get(req.apiKey!.projectId);
    const client = await pool.connect();

    try {
      const result = await withIdentity(client, identity, () => client.query(sql, filters.values as never[]));
      let total: number | undefined;
      if (q['count'] === 'exact') {
        const countSql = `SELECT COUNT(*)::int AS count FROM ${quoteQualified(schema, table)} ${filters.sql}`;
        const counted = await withIdentity(client, identity, () => client.query<{ count: number }>(countSql, filters.values as never[]));
        total = counted.rows[0]?.count;
      }
      reply.header('content-range', `${offset}-${offset + result.rowCount! - 1}/${total ?? '*'}`);
      return { data: result.rows, error: null, meta: { limit, offset, count: result.rowCount, total } };
    } catch (err) {
      throw new ApiError('DATABASE_ERROR', (err as Error).message);
    } finally {
      client.release();
    }
  });

  app.post('/rest/v1/:table', guard, async (req, reply) => {
    await consume('rest', req.apiKey!.projectId, RULES.api);
    const { table } = z.object({ table: z.string().min(1) }).parse(req.params);
    const schema = (req.query as { schema?: string }).schema ?? 'public';
    const payload = Array.isArray(req.body) ? req.body : [req.body];
    if (payload.length === 0) throw new ApiError('VALIDATION_ERROR', 'Provide at least one row');

    const columns = Object.keys(payload[0] as Record<string, unknown>);
    if (columns.length === 0) throw new ApiError('VALIDATION_ERROR', 'Rows must have at least one column');

    const values: unknown[] = [];
    let index = 1;
    const tuples = payload.map((row) => {
      const record = row as Record<string, unknown>;
      return `(${columns.map((c) => { values.push(record[c] ?? null); return `$${index++}`; }).join(', ')})`;
    });

    const sql = `INSERT INTO ${quoteQualified(schema, table)} (${columns.map(quoteIdent).join(', ')})
                 VALUES ${tuples.join(', ')} RETURNING *`;

    const identity = await resolveIdentity(req);
    const pool = await poolManager.get(req.apiKey!.projectId);
    const client = await pool.connect();
    try {
      const result = await withIdentity(client, identity, () => client.query(sql, values as never[]));
      void publishEvent(req.apiKey!.projectId, 'database.insert', { schema, table, rows: result.rows });
      return reply.code(201).send({ data: result.rows, error: null });
    } catch (err) {
      throw new ApiError('DATABASE_ERROR', (err as Error).message);
    } finally {
      client.release();
    }
  });

  app.patch('/rest/v1/:table', guard, async (req) => {
    await consume('rest', req.apiKey!.projectId, RULES.api);
    const { table } = z.object({ table: z.string().min(1) }).parse(req.params);
    const q = req.query as Record<string, string | undefined>;
    const schema = q['schema'] ?? 'public';
    const patch = req.body as Record<string, unknown>;
    if (!patch || Object.keys(patch).length === 0) throw new ApiError('VALIDATION_ERROR', 'Provide fields to update');

    const values: unknown[] = [];
    let index = 1;
    const assignments = Object.entries(patch).map(([column, value]) => {
      values.push(value);
      return `${quoteIdent(column)} = $${index++}`;
    });

    const filters = buildFilters(q, index);
    // An unfiltered UPDATE would rewrite the whole table; require a filter.
    if (!filters.sql) throw new ApiError('VALIDATION_ERROR', 'Add at least one filter before updating rows');
    values.push(...filters.values);

    const sql = `UPDATE ${quoteQualified(schema, table)} SET ${assignments.join(', ')} ${filters.sql} RETURNING *`;
    const identity = await resolveIdentity(req);
    const pool = await poolManager.get(req.apiKey!.projectId);
    const client = await pool.connect();
    try {
      const result = await withIdentity(client, identity, () => client.query(sql, values as never[]));
      void publishEvent(req.apiKey!.projectId, 'database.update', { schema, table, rows: result.rows });
      return { data: result.rows, error: null };
    } catch (err) {
      throw new ApiError('DATABASE_ERROR', (err as Error).message);
    } finally {
      client.release();
    }
  });

  app.delete('/rest/v1/:table', guard, async (req) => {
    await consume('rest', req.apiKey!.projectId, RULES.api);
    const { table } = z.object({ table: z.string().min(1) }).parse(req.params);
    const q = req.query as Record<string, string | undefined>;
    const schema = q['schema'] ?? 'public';
    const filters = buildFilters(q, 1);
    if (!filters.sql) throw new ApiError('VALIDATION_ERROR', 'Add at least one filter before deleting rows');

    const sql = `DELETE FROM ${quoteQualified(schema, table)} ${filters.sql} RETURNING *`;
    const identity = await resolveIdentity(req);
    const pool = await poolManager.get(req.apiKey!.projectId);
    const client = await pool.connect();
    try {
      const result = await withIdentity(client, identity, () => client.query(sql, filters.values as never[]));
      void publishEvent(req.apiKey!.projectId, 'database.delete', { schema, table, rows: result.rows });
      return { data: result.rows, error: null };
    } catch (err) {
      throw new ApiError('DATABASE_ERROR', (err as Error).message);
    } finally {
      client.release();
    }
  });

  /**
   * Dashboard-side row browsing. Same engine as /rest/v1, but authenticated
   * with a session instead of an API key and always RLS-bypassing, because the
   * project member is inspecting their own data.
   */
  const handleRows = async (req: FastifyRequest) => {
    const { table } = z.object({ table: z.string().min(1) }).parse(req.params);
    const q = req.query as Record<string, string | undefined>;
    const schema = q['schema'] ?? 'public';
    const limit = Math.min(Number(q['limit'] ?? 50) || 50, 500);
    const offset = Math.max(Number(q['offset'] ?? 0) || 0, 0);
    const filters = buildFilters(q, 1);

    const pool = await poolManager.get(req.project!.id);
    const qualified = quoteQualified(schema, table);
    try {
      const [rows, count] = await Promise.all([
        pool.query(
          `SELECT * FROM ${qualified} ${filters.sql} ${buildOrder(q['order'])} LIMIT ${limit} OFFSET ${offset}`,
          filters.values as never[],
        ),
        pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${qualified} ${filters.sql}`, filters.values as never[]),
      ]);
      return {
        data: rows.rows,
        error: null,
        meta: { limit, offset, total: count.rows[0]?.count ?? 0, fields: rows.fields.map((f) => f.name) },
      };
    } catch (err) {
      throw new ApiError('DATABASE_ERROR', (err as Error).message);
    }
  };

  app.get('/api/v1/projects/:projectId/database/tables/:table/rows', { preHandler: [app.requireProject('database.read')] }, handleRows);
  app.get('/projects/:projectId/database/tables/:table/rows', { preHandler: [app.requireProject('database.read')] }, handleRows);

  /** Dashboard-side row insertion */
  const handleInsertRow = async (req: FastifyRequest, reply: FastifyReply) => {
    const { table } = z.object({ table: z.string().min(1) }).parse(req.params);
    const q = req.query as Record<string, string | undefined>;
    const schema = q['schema'] ?? 'public';

    const body = req.body as Record<string, unknown> | { row: Record<string, unknown> };
    const rowData =
      body && typeof body === 'object' && 'row' in body && body.row && typeof body.row === 'object'
        ? (body.row as Record<string, unknown>)
        : (body as Record<string, unknown>);

    if (!rowData || typeof rowData !== 'object') {
      throw new ApiError('VALIDATION_ERROR', 'Missing row data');
    }

    const pool = await poolManager.get(req.project!.id);
    const qualified = quoteQualified(schema, table);

    // Introspect table columns to sanitize empty strings and defaults
    const colRes = await pool.query(
      `SELECT column_name, data_type, udt_name, is_nullable = 'YES' AS is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2`,
      [schema, table],
    );
    const colInfoMap = new Map<string, { udt_name: string; is_nullable: boolean; has_default: boolean }>(
      colRes.rows.map((r: any) => [
        r.column_name,
        {
          udt_name: r.udt_name?.toLowerCase?.() || '',
          is_nullable: Boolean(r.is_nullable),
          has_default: Boolean(r.column_default),
        },
      ]),
    );

    // Filter and sanitize entries so empty strings do not violate UUID/FK/type constraints
    const entries: [string, unknown][] = [];
    for (const [k, v] of Object.entries(rowData)) {
      if (v === undefined) continue;

      const colInfo = colInfoMap.get(k);
      let sanitizedVal = v;

      if (typeof v === 'string' && v.trim() === '') {
        if (colInfo) {
          if (colInfo.has_default) {
            // Omit to let database DEFAULT evaluate
            continue;
          } else if (colInfo.is_nullable) {
            sanitizedVal = null;
          } else if (
            colInfo.udt_name === 'uuid' ||
            colInfo.udt_name === 'inet' ||
            colInfo.udt_name.includes('int') ||
            colInfo.udt_name.includes('float') ||
            colInfo.udt_name.includes('numeric') ||
            colInfo.udt_name.includes('bool') ||
            colInfo.udt_name.includes('timestamp') ||
            colInfo.udt_name.includes('date') ||
            colInfo.udt_name.includes('json')
          ) {
            sanitizedVal = null;
          }
        } else {
          sanitizedVal = null;
        }
      }

      entries.push([k, sanitizedVal]);
    }

    try {
      let result;
      if (entries.length === 0) {
        result = await pool.query(`INSERT INTO ${qualified} DEFAULT VALUES RETURNING *`);
      } else {
        const columns = entries.map(([k]) => quoteIdent(k));
        const values: unknown[] = [];
        const placeholders = entries.map(([, v], i) => {
          values.push(v);
          return `$${i + 1}`;
        });
        const sql = `INSERT INTO ${qualified} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
        result = await pool.query(sql, values);
      }

      void publishEvent(req.project!.id, 'database.insert', { schema, table, rows: result.rows });
      return reply.code(201).send({ data: result.rows[0], error: null });
    } catch (err) {
      throw new ApiError('DATABASE_ERROR', (err as Error).message);
    }
  };

  app.post('/api/v1/projects/:projectId/database/tables/:table/rows', { preHandler: [app.requireProject('database.write')] }, handleInsertRow);
  app.post('/projects/:projectId/database/tables/:table/rows', { preHandler: [app.requireProject('database.write')] }, handleInsertRow);

  /** Dashboard-side row deletion */
  const handleDeleteRow = async (req: FastifyRequest) => {
    const { table } = z.object({ table: z.string().min(1) }).parse(req.params);
    const q = req.query as Record<string, string | undefined>;
    const schema = q['schema'] ?? 'public';
    const filters = buildFilters(q, 1);
    if (!filters.sql) throw new ApiError('VALIDATION_ERROR', 'Add at least one filter before deleting rows');

    const pool = await poolManager.get(req.project!.id);
    const qualified = quoteQualified(schema, table);
    try {
      const result = await pool.query(`DELETE FROM ${qualified} ${filters.sql} RETURNING *`, filters.values as never[]);
      void publishEvent(req.project!.id, 'database.delete', { schema, table, rows: result.rows });
      return { data: result.rows, error: null };
    } catch (err) {
      throw new ApiError('DATABASE_ERROR', (err as Error).message);
    }
  };

  app.delete('/api/v1/projects/:projectId/database/tables/:table/rows', { preHandler: [app.requireProject('database.write')] }, handleDeleteRow);
  app.delete('/projects/:projectId/database/tables/:table/rows', { preHandler: [app.requireProject('database.write')] }, handleDeleteRow);
}
