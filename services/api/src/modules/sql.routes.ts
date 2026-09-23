import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { env } from '../env.js';
import { many, query } from '../db/platform.js';
import { poolManager } from '../db/pool-manager.js';
import { ApiError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { consume, RULES } from '../lib/rate-limit.js';
import { classifyStatement } from '../lib/sql.js';
import { can } from '../lib/rbac.js';

const runBody = z.object({
  query: z.string().min(1).max(100_000),
  readOnly: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
});

export default async function sqlRoutes(app: FastifyInstance) {
 
  app.post('/projects/:projectId/sql', { preHandler: [app.requireProject('database.read')] }, async (req) => {
    await consume('sql', `${req.project!.id}:${req.user!.id}`, RULES.sql);
    const body = runBody.parse(req.body);
    const kind = classifyStatement(body.query);
    const role = req.project!.role;

    if (kind === 'write' && !can(role, 'database.write')) {
      throw new ApiError('FORBIDDEN', 'Your role can read data but not modify it');
    }
    if ((kind === 'ddl' || kind === 'destructive' || kind === 'admin') && !can(role, 'database.admin')) {
      throw new ApiError('FORBIDDEN', 'Only project admins and owners can run schema changes');
    }

    const readOnly = body.readOnly ?? kind === 'read';
    const timeout = body.timeoutMs ?? env.SQL_STATEMENT_TIMEOUT_MS;
    const pool = await poolManager.get(req.project!.id);
    const client = await pool.connect();
    const started = process.hrtime.bigint();

    try {
      await client.query(`BEGIN${readOnly ? ' READ ONLY' : ''}`);
      await client.query(`SET LOCAL statement_timeout = ${Number(timeout)}`);
      const result = await client.query(body.query);
      await client.query('COMMIT');

      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const results = Array.isArray(result) ? result : [result];
      const last = results[results.length - 1]!;

      void query(
        `INSERT INTO query_logs (project_id, user_id, statement, duration_ms, row_count, succeeded)
         VALUES ($1,$2,$3,$4,$5,TRUE)`,
        [req.project!.id, req.user!.id, body.query.slice(0, 10_000), durationMs.toFixed(3), last.rowCount ?? 0],
      ).catch(() => undefined);

      if (kind !== 'read') {
        void audit(req, {
          action: 'SQL_EXECUTED', projectId: req.project!.id, resourceType: 'sql',
          metadata: { kind, durationMs: Math.round(durationMs) },
        });
      }

      return {
        data: {
          rows: last.rows ?? [],
          fields: (last.fields ?? []).map((f: any) => ({ name: f.name, dataTypeId: f.dataTypeID })),
          rowCount: last.rowCount ?? 0,
          command: last.command,
          durationMs: Number(durationMs.toFixed(3)),
          statements: results.length,
        },
        error: null,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const message = (err as Error).message;

      void query(
        `INSERT INTO query_logs (project_id, user_id, statement, duration_ms, succeeded, error)
         VALUES ($1,$2,$3,$4,FALSE,$5)`,
        [req.project!.id, req.user!.id, body.query.slice(0, 10_000), durationMs.toFixed(3), message.slice(0, 2000)],
      ).catch(() => undefined);

      // Postgres error text is useful to the developer and safe here: it is
      // their own database, and the message never contains platform internals.
      throw new ApiError('DATABASE_ERROR', message, {
        position: (err as { position?: string }).position,
        hint: (err as { hint?: string }).hint,
      });
    } finally {
      client.release();
    }
  });

  /**
   * Query plan analysis.
   *
   * `EXPLAIN (ANALYZE)` actually runs the query, which is the only way to get
   * real row counts and timings — and also the reason this refuses anything
   * that writes. "Let me just check the plan" should never be how a DELETE
   * gets executed.
   *
   * The findings are the point. A raw plan is a wall of text; the specific
   * things worth acting on are seq scans on large tables, estimates that are
   * wildly off, and spills to disk.
   */
  app.post('/projects/:projectId/sql/explain', { preHandler: [app.requireProject('database.read')] }, async (req) => {
    await consume('sql', req.project!.id, RULES.sql);
    const body = z.object({
      query: z.string().min(1).max(100_000),
      analyze: z.boolean().default(false),
    }).parse(req.body);

    const classification = classifyStatement(body.query);
    if (body.analyze && classification !== 'read') {
      throw new ApiError(
        'FORBIDDEN',
        'EXPLAIN ANALYZE runs the query. Drop analyze to see the plan for a statement that writes.',
      );
    }

    const pool = await poolManager.get(req.project!.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${env.SQL_STATEMENT_TIMEOUT_MS}`);
      const options = body.analyze ? 'ANALYZE, BUFFERS, FORMAT JSON' : 'FORMAT JSON';
      const result = await client.query<{ 'QUERY PLAN': unknown[] }>(`EXPLAIN (${options}) ${body.query}`);
      await client.query('ROLLBACK');

      const plan = result.rows[0]?.['QUERY PLAN']?.[0] as
        | { Plan: Record<string, unknown>; 'Execution Time'?: number; 'Planning Time'?: number }
        | undefined;
      if (!plan) throw new ApiError('DATABASE_ERROR', 'PostgreSQL returned no plan');

      const findings: { severity: 'warn' | 'info'; message: string }[] = [];

      const walk = (node: Record<string, unknown>): void => {
        const nodeType = String(node['Node Type'] ?? '');
        const relation = node['Relation Name'] as string | undefined;
        const planRows = Number(node['Plan Rows'] ?? 0);
        const actualRows = Number(node['Actual Rows'] ?? planRows);

        if (nodeType === 'Seq Scan' && relation && actualRows > 1000) {
          findings.push({
            severity: 'warn',
            message: `Sequential scan over ${actualRows} rows in ${relation}. An index on the filtered column would usually fix this.`,
          });
        }

        // An estimate off by more than 10x means the planner is choosing joins
        // on bad information, which is a statistics problem rather than an
        // index one — different fix, so worth distinguishing.
        if (body.analyze && planRows > 0 && actualRows > 0) {
          const ratio = Math.max(actualRows / planRows, planRows / actualRows);
          if (ratio > 10) {
            findings.push({
              severity: 'warn',
              message: `${nodeType}${relation ? ` on ${relation}` : ''} estimated ${planRows} rows and got ${actualRows}. Run ANALYZE ${relation ?? ''} — the planner is working from stale statistics.`,
            });
          }
        }

        if (node['Sort Method'] === 'external merge') {
          findings.push({
            severity: 'warn',
            message: 'A sort spilled to disk. work_mem is too low for this query — see scripts/tune-postgres.sh.',
          });
        }

        for (const child of (node['Plans'] as Record<string, unknown>[] | undefined) ?? []) walk(child);
      };
      walk(plan.Plan);

      if (findings.length === 0) {
        findings.push({ severity: 'info', message: 'Nothing obviously wrong with this plan.' });
      }

      return {
        data: {
          plan: plan.Plan,
          planningTimeMs: plan['Planning Time'] ?? null,
          executionTimeMs: plan['Execution Time'] ?? null,
          analyzed: body.analyze,
          findings,
        },
        error: null,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof ApiError) throw error;
      throw new ApiError('DATABASE_ERROR', (error as Error).message);
    } finally {
      client.release();
    }
  });

  app.get('/projects/:projectId/sql/history', { preHandler: [app.requireProject('logs.read')] }, async (req) => {
    const q = z.object({ limit: z.coerce.number().min(1).max(200).default(50) }).parse(req.query);
    const rows = await many(
      `SELECT id, statement, duration_ms, row_count, succeeded, error, created_at
         FROM query_logs WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [req.project!.id, q.limit],
    );
    return { data: rows, error: null };
  });

  /** Slow-query report, backed by pg_stat_statements when the extension is present. */
  app.get('/projects/:projectId/sql/stats', { preHandler: [app.requireProject('logs.read')] }, async (req) => {
    const pool = await poolManager.get(req.project!.id);
    try {
      const { rows } = await pool.query(`
        SELECT query, calls, total_exec_time AS total_ms, mean_exec_time AS mean_ms, rows
          FROM pg_stat_statements
         ORDER BY mean_exec_time DESC
         LIMIT 20`);
      return { data: { source: 'pg_stat_statements', statements: rows }, error: null };
    } catch {
      // Fall back to the platform's own query log when the extension is missing.
      const rows = await many(
        `SELECT statement AS query, COUNT(*)::int AS calls,
                SUM(duration_ms) AS total_ms, AVG(duration_ms) AS mean_ms
           FROM query_logs WHERE project_id = $1
          GROUP BY statement ORDER BY AVG(duration_ms) DESC LIMIT 20`,
        [req.project!.id],
      );
      return { data: { source: 'query_logs', statements: rows }, error: null };
    }
  });

  /**
   * Deep Schema Metadata Catalog for the Advanced SQL IDE.
   * Returns schemas, tables, columns, PKs, FKs, views, functions, triggers, sequences, enums, extensions.
   */
  app.get('/projects/:projectId/sql/schema', { preHandler: [app.requireProject('database.read')] }, async (req) => {
    const pool = await poolManager.get(req.project!.id);
    const client = await pool.connect();
    try {
      const [
        dbRes,
        tablesRes,
        viewsRes,
        matviewsRes,
        columnsRes,
        functionsRes,
        triggersRes,
        indexesRes,
        extensionsRes,
        enumsRes,
        sequencesRes,
      ] = await Promise.all([
        client.query('SELECT current_database() AS database'),
        // 1. Ordinary Tables only (relkind = 'r')
        client.query(`
          SELECT
            c.oid,
            n.nspname AS schema_name,
            c.relname AS table_name,
            COALESCE(c.reltuples::bigint, 0) AS estimated_rows,
            COALESCE(pg_total_relation_size(c.oid), 0) AS size_bytes,
            c.relrowsecurity AS rls_enabled
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind = 'r'
          ORDER BY c.relname;
        `),
        // 2. Views only (relkind = 'v')
        client.query(`
          SELECT
            c.oid,
            n.nspname AS schema_name,
            c.relname AS view_name,
            COALESCE(pg_get_viewdef(c.oid, true), '') AS definition
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind = 'v'
          ORDER BY c.relname;
        `),
        // 3. Materialized Views only (relkind = 'm')
        client.query(`
          SELECT
            c.oid,
            n.nspname AS schema_name,
            c.relname AS matview_name,
            COALESCE(pg_get_viewdef(c.oid, true), '') AS definition
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind = 'm'
          ORDER BY c.relname;
        `),
        // 4. Columns for public tables and views
        client.query(`
          SELECT
            c.table_schema,
            c.table_name,
            c.column_name,
            c.data_type,
            c.is_nullable = 'YES' AS is_nullable,
            c.column_default,
            c.ordinal_position,
            COALESCE(pk.is_pk, false) AS is_primary_key,
            fk.foreign_table,
            fk.foreign_column
          FROM information_schema.columns c
          LEFT JOIN (
            SELECT kcu.table_schema, kcu.table_name, kcu.column_name, true AS is_pk
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
          ) pk ON pk.table_schema = c.table_schema AND pk.table_name = c.table_name AND pk.column_name = c.column_name
          LEFT JOIN (
            SELECT
              kcu.table_schema, kcu.table_name, kcu.column_name,
              ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
          ) fk ON fk.table_schema = c.table_schema AND fk.table_name = c.table_name AND fk.column_name = c.column_name
          WHERE c.table_schema = 'public'
          ORDER BY c.table_name, c.ordinal_position;
        `),
        // 5. User-defined functions only (scoped to public, excluding extension-owned functions)
        client.query(`
          SELECT
            p.oid,
            n.nspname AS schema_name,
            p.proname AS function_name,
            pg_get_function_identity_arguments(p.oid) AS arguments,
            pg_get_function_result(p.oid) AS return_type,
            l.lanname AS language,
            p.prosecdef AS is_security_definer
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          JOIN pg_catalog.pg_language l ON l.oid = p.prolang
          LEFT JOIN pg_catalog.pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
          WHERE n.nspname = 'public'
            AND d.objid IS NULL
          ORDER BY p.proname;
        `),
        // 6. Triggers on public tables
        client.query(`
          SELECT
            event_object_schema AS schema_name,
            event_object_table AS table_name,
            trigger_name,
            action_timing,
            event_manipulation
          FROM information_schema.triggers
          WHERE event_object_schema = 'public'
          ORDER BY trigger_name;
        `),
        // 7. Indexes in public
        client.query(`
          SELECT
            schemaname AS schema_name,
            tablename,
            indexname AS index_name,
            indexdef AS definition
          FROM pg_catalog.pg_indexes
          WHERE schemaname = 'public'
          ORDER BY tablename, indexname;
        `),
        // 8. Extensions
        client.query(`
          SELECT
            e.oid,
            e.extname AS extension_name,
            e.extversion AS version,
            COALESCE(n.nspname, 'public') AS schema_name
          FROM pg_catalog.pg_extension e
          LEFT JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
          ORDER BY e.extname;
        `),
        // 9. Enums in public
        client.query(`
          SELECT
            n.nspname AS schema_name,
            t.typname AS enum_name,
            array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
          FROM pg_catalog.pg_type t
          JOIN pg_catalog.pg_enum e ON t.oid = e.enumtypid
          JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public'
          GROUP BY n.nspname, t.typname
          ORDER BY t.typname;
        `),
        // 10. Sequences in public
        client.query(`
          SELECT
            sequence_schema AS schema_name,
            sequence_name,
            data_type 
          FROM information_schema.sequences 
          WHERE sequence_schema = 'public'
          ORDER BY sequence_name;
        `),
      ]);

      return {
        data: {
          database: dbRes.rows[0]?.database ?? 'project_db',
          schema: 'public',
          tables: tablesRes.rows,
          views: viewsRes.rows,
          materializedViews: matviewsRes.rows,
          functions: functionsRes.rows,
          indexes: indexesRes.rows,
          columns: columnsRes.rows,
          triggers: triggersRes.rows,
          sequences: sequencesRes.rows,
          enums: enumsRes.rows,
          extensions: extensionsRes.rows,
        },
        error: null,
      };
    } finally {
      client.release();
    }
  });

  /**
   * Advanced Query Execution Endpoint with Parameter binding, detailed timings & normalized diagnostics.
   */
  app.post('/projects/:projectId/sql/execute', { preHandler: [app.requireProject('database.read')] }, async (req) => {
    await consume('sql', `${req.project!.id}:${req.user!.id}`, RULES.sql);
    const body = z.object({
      sql: z.string().min(1, 'SQL statement cannot be empty').max(100_000),
      parameters: z.array(z.unknown()).optional(),
      readOnly: z.boolean().optional(),
      timeoutMs: z.number().int().min(100).max(120_000).optional(),
    }).parse(req.body);

    if (!body.sql || body.sql.trim().length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'SQL statement cannot be empty');
    }

    const kind = classifyStatement(body.sql);
    const role = req.project!.role;

    if (kind === 'write' && !can(role, 'database.write')) {
      throw new ApiError('FORBIDDEN', 'Your role can read data but not modify it');
    }
    if ((kind === 'ddl' || kind === 'destructive' || kind === 'admin') && !can(role, 'database.admin')) {
      throw new ApiError('FORBIDDEN', 'Only project admins and owners can run schema changes');
    }

    const readOnly = body.readOnly ?? kind === 'read';
    const timeout = body.timeoutMs ?? env.SQL_STATEMENT_TIMEOUT_MS;
    const pool = await poolManager.get(req.project!.id);
    const client = await pool.connect();
    const started = process.hrtime.bigint();

    try {
      await client.query(`BEGIN${readOnly ? ' READ ONLY' : ''}`);
      await client.query(`SET LOCAL statement_timeout = ${Number(timeout)}`);
      
      const queryStart = process.hrtime.bigint();
      const result = body.parameters && body.parameters.length > 0
        ? await client.query(body.sql, body.parameters)
        : await client.query(body.sql);
      const queryDurationMs = Number(process.hrtime.bigint() - queryStart) / 1e6;

      await client.query('COMMIT');

      const totalDurationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const results = Array.isArray(result) ? result : [result];
      const last = results[results.length - 1]!;

      // Normalize query hash for analytics
      const normalizedQuery = body.sql.replace(/\s+/g, ' ').replace(/\b\d+\b/g, '?').replace(/'[^']*'/g, '?').trim().toLowerCase();
      const queryHash = crypto.createHash('sha256').update(normalizedQuery).digest('hex').slice(0, 16);

      void query(
        `INSERT INTO query_logs (project_id, user_id, statement, duration_ms, row_count, succeeded)
         VALUES ($1,$2,$3,$4,$5,TRUE)`,
        [req.project!.id, req.user!.id, body.sql.slice(0, 10_000), totalDurationMs.toFixed(3), last.rowCount ?? 0],
      ).catch(() => undefined);

      if (kind !== 'read') {
        void audit(req, {
          action: 'SQL_EXECUTED',
          projectId: req.project!.id,
          resourceType: 'sql',
          metadata: { kind, durationMs: Math.round(totalDurationMs), queryHash },
        });
      }

      return {
        data: last.rows ?? [],
        columns: (last.fields ?? []).map((f: any) => ({ name: f.name, dataTypeId: f.dataTypeID })),
        rowCount: last.rowCount ?? (last.rows ? last.rows.length : 0),
        rowsAffected: last.command !== 'SELECT' ? (last.rowCount ?? 0) : 0,
        command: last.command,
        meta: {
          executionTimeMs: Number(queryDurationMs.toFixed(2)),
          totalDurationMs: Number(totalDurationMs.toFixed(2)),
          serverTimeMs: Number((totalDurationMs - queryDurationMs).toFixed(2)),
          queryHash,
          requestId: `req_${crypto.randomUUID().slice(0, 12)}`,
          statements: results.length,
        },
        error: null,
      };
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      const totalDurationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const message = err.message || 'Database execution error';

      void query(
        `INSERT INTO query_logs (project_id, user_id, statement, duration_ms, succeeded, error)
         VALUES ($1,$2,$3,$4,FALSE,$5)`,
        [req.project!.id, req.user!.id, body.sql.slice(0, 10_000), totalDurationMs.toFixed(3), message.slice(0, 2000)],
      ).catch(() => undefined);

      const charPos = parseInt(err.position, 10);
      let line = 1;
      let column = 1;
      if (!isNaN(charPos)) {
        const lines = body.sql.slice(0, charPos).split('\n');
        line = lines.length;
        column = lines[lines.length - 1]?.length ?? 1;
      }

      throw new ApiError('DATABASE_ERROR', message, {
        code: err.code,
        line,
        column,
        position: err.position,
        hint: err.hint,
        detail: err.detail,
      });
    } finally {
      client.release();
    }
  });

  /**
   * Query Cancellation Endpoint.
   * Cancels a running PostgreSQL backend query using pg_cancel_backend.
   */
  app.post('/projects/:projectId/sql/cancel', { preHandler: [app.requireProject('database.write')] }, async (req) => {
    const body = z.object({ pid: z.number().int() }).parse(req.body);
    const pool = await poolManager.get(req.project!.id);
    const result = await pool.query('SELECT pg_cancel_backend($1) AS cancelled', [body.pid]);
    return { data: { cancelled: Boolean(result.rows[0]?.cancelled) }, error: null };
  });

  /**
   * Database Diagnostics Endpoint.
   * Connections, locks, table sizes, cache hit ratios, and slow queries.
   */
  app.get('/projects/:projectId/sql/diagnostics', { preHandler: [app.requireProject('database.read')] }, async (req) => {
    const pool = await poolManager.get(req.project!.id);
    const client = await pool.connect();
    try {
      const [connectionsRes, locksRes, cacheRes, tablesRes, slowQueriesRes] = await Promise.all([
        client.query(`
          SELECT pid, usename, client_addr::text, state, query,
                 COALESCE(extract(epoch from (now() - query_start))::numeric(10,2), 0) AS duration_seconds,
                 wait_event_type, wait_event
          FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
          ORDER BY query_start ASC NULLS LAST
          LIMIT 25
        `),
        client.query(`
          SELECT
            blocked_locks.pid AS blocked_pid,
            blocking_locks.pid AS blocking_pid,
            blocked_activity.query AS blocked_statement,
            blocking_activity.query AS blocking_statement
          FROM pg_catalog.pg_locks blocked_locks
          JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
          JOIN pg_catalog.pg_locks blocking_locks 
            ON blocking_locks.locktype = blocked_locks.locktype
            AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
            AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
            AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
            AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
            AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
            AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
            AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
            AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
            AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
            AND blocking_locks.pid != blocked_locks.pid
          JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
          WHERE NOT blocked_locks.granted
          LIMIT 10
        `).catch(() => ({ rows: [] })),
        client.query(`
          SELECT
            COALESCE(sum(blks_hit) * 100.0 / NULLIF(sum(blks_hit + blks_read), 0), 100.0)::numeric(5,2) AS cache_hit_ratio,
            COALESCE(sum(xact_commit), 0)::bigint AS commits,
            COALESCE(sum(xact_rollback), 0)::bigint AS rollbacks
          FROM pg_stat_database
          WHERE datname = current_database()
        `),
        client.query(`
          SELECT
            relname AS table_name,
            COALESCE(n_live_tup, 0)::bigint AS live_rows,
            COALESCE(n_dead_tup, 0)::bigint AS dead_rows,
            pg_total_relation_size(relid) AS total_bytes,
            pg_relation_size(relid) AS table_bytes,
            pg_indexes_size(relid) AS index_bytes
          FROM pg_stat_user_tables
          ORDER BY total_bytes DESC
          LIMIT 20
        `),
        many(
          `SELECT id, statement AS query, duration_ms, row_count, created_at
             FROM query_logs
            WHERE project_id = $1 AND duration_ms > 500
            ORDER BY created_at DESC LIMIT 15`,
          [req.project!.id],
        ).catch(() => []),
      ]);

      return {
        data: {
          connections: connectionsRes.rows,
          locks: locksRes.rows,
          cacheHitRatio: parseFloat(cacheRes.rows[0]?.cache_hit_ratio ?? '99.5'),
          commits: Number(cacheRes.rows[0]?.commits ?? 0),
          rollbacks: Number(cacheRes.rows[0]?.rollbacks ?? 0),
          tables: tablesRes.rows,
          slowQueries: slowQueriesRes,
        },
        error: null,
      };
    } finally {
      client.release();
    }
  });
}
