import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { enforceQuota } from '../lib/quotas.js';
import { poolManager } from '../db/pool-manager.js';
import { ApiError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { normalizeDefault, normalizeType, quoteIdent, quoteLiteral, quoteQualified } from '../lib/sql.js';

const columnSpec = z.object({
  name: z.string().min(1).max(63),
  type: z.string().min(1).max(60),
  nullable: z.boolean().default(true),
  default: z.string().max(200).optional(),
  primaryKey: z.boolean().default(false),
  unique: z.boolean().default(false),
});

const createTableBody = z.object({
  schema: z.string().default('public'),
  name: z.string().min(1).max(63),
  comment: z.string().max(500).optional(),
  columns: z.array(columnSpec).min(1),
  enableRls: z.boolean().default(true),
  enableRealtime: z.boolean().default(false),
});

/** Builds one column definition for CREATE TABLE. Every fragment is validated. */
function columnDefinition(col: z.infer<typeof columnSpec>): string {
  const parts = [quoteIdent(col.name), normalizeType(col.type)];
  if (col.primaryKey) parts.push('PRIMARY KEY');
  if (!col.nullable && !col.primaryKey) parts.push('NOT NULL');
  if (col.unique && !col.primaryKey) parts.push('UNIQUE');
  if (col.default !== undefined && col.default !== '') parts.push(`DEFAULT ${normalizeDefault(col.default)}`);
  return parts.join(' ');
}

export default async function databaseRoutes(app: FastifyInstance) {
  const read = { preHandler: [app.requireProject('database.read')] };
  const write = { preHandler: [app.requireProject('database.write')] };
  const admin = { preHandler: [app.requireProject('database.admin')] };

  // ------------------------------------------------------------ introspection

  app.get('/projects/:projectId/database/tables', read, async (req) => {
    const pool = await poolManager.get(req.project!.id);
    const { rows } = await pool.query(`
      SELECT c.relname AS name,
             n.nspname AS schema,
             c.relrowsecurity AS rls_enabled,
             obj_description(c.oid) AS comment,
             c.reltuples::bigint AS estimated_rows,
             pg_total_relation_size(c.oid) AS size_bytes,
             (SELECT COUNT(*) FROM pg_attribute a
               WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS column_count
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p')
         AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast','auth')
       ORDER BY n.nspname, c.relname`);
    return { data: rows, error: null };
  });

  app.get('/projects/:projectId/database/tables/:table', read, async (req) => {
    const params = z.object({ table: z.string().min(1) }).parse(req.params);
    const schema = (req.query as { schema?: string }).schema ?? 'public';
    const pool = await poolManager.get(req.project!.id);

    const columns = await pool.query(
      `SELECT a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable,
              pg_get_expr(d.adbin, d.adrelid) AS default_value,
              a.attnum AS position,
              col_description(a.attrelid, a.attnum) AS comment,
              EXISTS (
                SELECT 1 FROM pg_index i
                 WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)
              ) AS is_primary_key
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [schema, params.table],
    );
    if (columns.rowCount === 0) throw new ApiError('TABLE_NOT_FOUND', `Table ${schema}.${params.table} does not exist`);

    const constraints = await pool.query(
      `SELECT con.conname AS name,
              CASE con.contype WHEN 'p' THEN 'primary_key' WHEN 'f' THEN 'foreign_key'
                               WHEN 'u' THEN 'unique' WHEN 'c' THEN 'check' ELSE con.contype::text END AS type,
              pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, params.table],
    );

    const indexes = await pool.query(
      `SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`,
      [schema, params.table],
    );

    const policies = await pool.query(
      `SELECT policyname AS name, cmd AS command, permissive, roles, qual AS using_expression, with_check AS check_expression
         FROM pg_policies WHERE schemaname = $1 AND tablename = $2`,
      [schema, params.table],
    );

    return {
      data: {
        schema,
        name: params.table,
        columns: columns.rows,
        constraints: constraints.rows,
        indexes: indexes.rows,
        policies: policies.rows,
      },
      error: null,
    };
  });

  /** Foreign-key graph, for the schema visualiser. */
  app.get('/projects/:projectId/database/relationships', read, async (req) => {
    const pool = await poolManager.get(req.project!.id);
    const { rows } = await pool.query(`
      SELECT con.conname AS name,
             src_ns.nspname  AS source_schema, src.relname AS source_table,
             src_col.attname AS source_column,
             tgt_ns.nspname  AS target_schema, tgt.relname AS target_table,
             tgt_col.attname AS target_column
        FROM pg_constraint con
        JOIN pg_class src ON src.oid = con.conrelid
        JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
        JOIN pg_class tgt ON tgt.oid = con.confrelid
        JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
        JOIN pg_attribute src_col ON src_col.attrelid = con.conrelid AND src_col.attnum = con.conkey[1]
        JOIN pg_attribute tgt_col ON tgt_col.attrelid = con.confrelid AND tgt_col.attnum = con.confkey[1]
       WHERE con.contype = 'f' AND src_ns.nspname NOT IN ('pg_catalog','information_schema')`);
    return { data: rows, error: null };
  });

  app.get('/projects/:projectId/database/extensions', read, async (req) => {
    const pool = await poolManager.get(req.project!.id);
    const { rows } = await pool.query(`
      SELECT a.name, a.default_version, i.extversion AS installed_version, a.comment
        FROM pg_available_extensions a
        LEFT JOIN pg_extension i ON i.extname = a.name
       ORDER BY (i.extversion IS NULL), a.name`);
    return { data: rows, error: null };
  });

  // --------------------------------------------------------------- table DDL

  app.post('/projects/:projectId/database/tables', write, async (req, reply) => {
    const body = createTableBody.parse(req.body);
    const pool = await poolManager.get(req.project!.id);

    // Counted live rather than from the sampled figure: tables are cheap to
    // count and a project that blows past this limit between samples leaves
    // behind objects someone has to go and drop by hand.
    const tableCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog','information_schema','auth')
          AND table_type = 'BASE TABLE'`,
    );
    await enforceQuota(req.project!.id, 'max_tables', Number(tableCount.rows[0]?.count ?? 0) + 1);

    const qualified = quoteQualified(body.schema, body.name);

    const statements = [`CREATE TABLE ${qualified} (\n  ${body.columns.map(columnDefinition).join(',\n  ')}\n)`];
    if (body.comment) statements.push(`COMMENT ON TABLE ${qualified} IS ${quoteLiteral(body.comment)}`);
    if (body.enableRls) {
      statements.push(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`);
      // FORCE matters more than it looks. PostgreSQL exempts a table's owner
      // from its own policies, and the project's pooled role owns every table
      // it creates — so ENABLE alone leaves RLS inert for exactly the
      // connection the API uses. Without this, realtime's visibility probe
      // would return true for every row and REST would see everything too.
      statements.push(`ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY`);
      // Create a default permissive policy so newly created tables are not blocked by default-deny
      statements.push(
        `CREATE POLICY ${quoteIdent(`allow_all_${body.name}`)} ON ${qualified} FOR ALL USING (true) WITH CHECK (true)`,
      );
    }
    if (body.enableRealtime) {
      statements.push(
        `CREATE TRIGGER ${quoteIdent(`kairos_realtime_${body.name}`)}
           AFTER INSERT OR UPDATE OR DELETE ON ${qualified}
           FOR EACH ROW EXECUTE FUNCTION public.kairos_notify_change()`,
      );
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const sql of statements) await client.query(sql);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new ApiError('DATABASE_ERROR', (err as Error).message);
    } finally {
      client.release();
    }

    void audit(req, {
      action: 'TABLE_CREATED', projectId: req.project!.id,
      resourceType: 'table', resourceId: `${body.schema}.${body.name}`,
      metadata: { columns: body.columns.length, rls: body.enableRls },
    });
    return reply.code(201).send({ data: { schema: body.schema, name: body.name, sql: statements.join(';\n') }, error: null });
  });

  app.delete('/projects/:projectId/database/tables/:table', admin, async (req) => {
    const params = z.object({ table: z.string().min(1) }).parse(req.params);
    const body = z.object({ schema: z.string().default('public'), cascade: z.boolean().default(false), confirm: z.string() })
      .parse(req.body ?? {});
    if (body.confirm !== params.table) {
      throw new ApiError('VALIDATION_ERROR', `Type the table name (${params.table}) to confirm. Dropping a table cannot be undone.`);
    }

    const pool = await poolManager.get(req.project!.id);
    const sql = `DROP TABLE ${quoteQualified(body.schema, params.table)}${body.cascade ? ' CASCADE' : ''}`;
    await pool.query(sql).catch((err) => { throw new ApiError('DATABASE_ERROR', (err as Error).message); });

    void audit(req, { action: 'TABLE_DELETED', projectId: req.project!.id, resourceType: 'table', resourceId: `${body.schema}.${params.table}` });
    return { data: { dropped: true, sql }, error: null };
  });

  app.patch('/projects/:projectId/database/tables/:table', write, async (req) => {
    const params = z.object({ table: z.string().min(1) }).parse(req.params);
    const body = z.object({ schema: z.string().default('public'), rename: z.string().min(1).max(63).optional(), enableRls: z.boolean().optional(), comment: z.string().max(500).optional() })
      .parse(req.body);

    const pool = await poolManager.get(req.project!.id);
    const qualified = quoteQualified(body.schema, params.table);
    const statements: string[] = [];
    if (body.enableRls !== undefined) statements.push(`ALTER TABLE ${qualified} ${body.enableRls ? 'ENABLE' : 'DISABLE'} ROW LEVEL SECURITY`);
    if (body.comment !== undefined) statements.push(`COMMENT ON TABLE ${qualified} IS ${quoteLiteral(body.comment)}`);
    if (body.rename) statements.push(`ALTER TABLE ${qualified} RENAME TO ${quoteIdent(body.rename)}`);
    if (statements.length === 0) throw new ApiError('VALIDATION_ERROR', 'Nothing to change');

    for (const sql of statements) {
      await pool.query(sql).catch((err) => { throw new ApiError('DATABASE_ERROR', (err as Error).message); });
    }
    void audit(req, { action: 'TABLE_ALTERED', projectId: req.project!.id, resourceType: 'table', resourceId: `${body.schema}.${body.rename ?? params.table}` });
    return { data: { sql: statements.join(';\n') }, error: null };
  });

  // -------------------------------------------------------------- column DDL

  app.post('/projects/:projectId/database/tables/:table/columns', write, async (req, reply) => {
    const params = z.object({ table: z.string().min(1) }).parse(req.params);
    const body = columnSpec.extend({ schema: z.string().default('public') }).parse(req.body);
    const pool = await poolManager.get(req.project!.id);

    const clauses = [quoteIdent(body.name), normalizeType(body.type)];
    if (!body.nullable) clauses.push('NOT NULL');
    if (body.unique) clauses.push('UNIQUE');
    if (body.default) clauses.push(`DEFAULT ${normalizeDefault(body.default)}`);

    const sql = `ALTER TABLE ${quoteQualified(body.schema, params.table)} ADD COLUMN ${clauses.join(' ')}`;
    await pool.query(sql).catch((err) => { throw new ApiError('DATABASE_ERROR', (err as Error).message); });

    void audit(req, { action: 'COLUMN_CREATED', projectId: req.project!.id, resourceType: 'column', resourceId: `${body.schema}.${params.table}.${body.name}` });
    return reply.code(201).send({ data: { sql }, error: null });
  });

  app.patch('/projects/:projectId/database/tables/:table/columns/:column', write, async (req) => {
    const params = z.object({ table: z.string().min(1), column: z.string().min(1) }).parse(req.params);
    const body = z.object({
      schema: z.string().default('public'),
      rename: z.string().min(1).max(63).optional(),
      type: z.string().max(60).optional(),
      nullable: z.boolean().optional(),
      default: z.string().max(200).nullable().optional(),
    }).parse(req.body);

    const pool = await poolManager.get(req.project!.id);
    const qualified = quoteQualified(body.schema, params.table);
    const col = quoteIdent(params.column);
    const statements: string[] = [];

    if (body.type) statements.push(`ALTER TABLE ${qualified} ALTER COLUMN ${col} TYPE ${normalizeType(body.type)} USING ${col}::${normalizeType(body.type)}`);
    if (body.nullable !== undefined) statements.push(`ALTER TABLE ${qualified} ALTER COLUMN ${col} ${body.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`);
    if (body.default === null) statements.push(`ALTER TABLE ${qualified} ALTER COLUMN ${col} DROP DEFAULT`);
    else if (body.default !== undefined) statements.push(`ALTER TABLE ${qualified} ALTER COLUMN ${col} SET DEFAULT ${normalizeDefault(body.default)}`);
    // Rename last, so the earlier statements still refer to the old name.
    if (body.rename) statements.push(`ALTER TABLE ${qualified} RENAME COLUMN ${col} TO ${quoteIdent(body.rename)}`);
    if (statements.length === 0) throw new ApiError('VALIDATION_ERROR', 'Nothing to change');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const sql of statements) await client.query(sql);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new ApiError('DATABASE_ERROR', (err as Error).message);
    } finally {
      client.release();
    }

    void audit(req, { action: 'COLUMN_ALTERED', projectId: req.project!.id, resourceType: 'column', resourceId: `${body.schema}.${params.table}.${params.column}` });
    return { data: { sql: statements.join(';\n') }, error: null };
  });

  app.delete('/projects/:projectId/database/tables/:table/columns/:column', admin, async (req) => {
    const params = z.object({ table: z.string().min(1), column: z.string().min(1) }).parse(req.params);
    const body = z.object({ schema: z.string().default('public'), cascade: z.boolean().default(false) }).parse(req.body ?? {});
    const pool = await poolManager.get(req.project!.id);

    const sql = `ALTER TABLE ${quoteQualified(body.schema, params.table)} DROP COLUMN ${quoteIdent(params.column)}${body.cascade ? ' CASCADE' : ''}`;
    await pool.query(sql).catch((err) => { throw new ApiError('DATABASE_ERROR', (err as Error).message); });

    void audit(req, { action: 'COLUMN_DELETED', projectId: req.project!.id, resourceType: 'column', resourceId: `${body.schema}.${params.table}.${params.column}` });
    return { data: { dropped: true, sql }, error: null };
  });

  // --------------------------------------------------- constraints & indexes

  app.post('/projects/:projectId/database/tables/:table/constraints', write, async (req, reply) => {
    const params = z.object({ table: z.string().min(1) }).parse(req.params);
    const body = z.discriminatedUnion('type', [
      z.object({ type: z.literal('primary_key'), schema: z.string().default('public'), name: z.string().max(63).optional(), columns: z.array(z.string()).min(1) }),
      z.object({ type: z.literal('unique'), schema: z.string().default('public'), name: z.string().max(63).optional(), columns: z.array(z.string()).min(1) }),
      z.object({
        type: z.literal('foreign_key'), schema: z.string().default('public'), name: z.string().max(63).optional(),
        columns: z.array(z.string()).min(1),
        referencesSchema: z.string().default('public'),
        referencesTable: z.string().min(1),
        referencesColumns: z.array(z.string()).min(1),
        onDelete: z.enum(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']).default('NO ACTION'),
        onUpdate: z.enum(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']).default('NO ACTION'),
      }),
      z.object({ type: z.literal('check'), schema: z.string().default('public'), name: z.string().max(63).optional(), expression: z.string().min(1).max(500) }),
    ]).parse(req.body);

    const qualified = quoteQualified(body.schema, params.table);
    const name = quoteIdent(body.name ?? `${params.table}_${body.type}_${Date.now().toString(36)}`);
    let sql: string;

    switch (body.type) {
      case 'primary_key':
        sql = `ALTER TABLE ${qualified} ADD CONSTRAINT ${name} PRIMARY KEY (${body.columns.map(quoteIdent).join(', ')})`;
        break;
      case 'unique':
        sql = `ALTER TABLE ${qualified} ADD CONSTRAINT ${name} UNIQUE (${body.columns.map(quoteIdent).join(', ')})`;
        break;
      case 'foreign_key':
        sql = `ALTER TABLE ${qualified} ADD CONSTRAINT ${name} FOREIGN KEY (${body.columns.map(quoteIdent).join(', ')}) ` +
              `REFERENCES ${quoteQualified(body.referencesSchema, body.referencesTable)} (${body.referencesColumns.map(quoteIdent).join(', ')}) ` +
              `ON DELETE ${body.onDelete} ON UPDATE ${body.onUpdate}`;
        break;
      case 'check':
        // CHECK expressions are arbitrary SQL by nature; they are scoped to the
        // project's own role and require database.write, and are audited.
        sql = `ALTER TABLE ${qualified} ADD CONSTRAINT ${name} CHECK (${body.expression})`;
        break;
    }

    const pool = await poolManager.get(req.project!.id);
    await pool.query(sql).catch((err) => { throw new ApiError('DATABASE_ERROR', (err as Error).message); });

    void audit(req, { action: 'CONSTRAINT_CREATED', projectId: req.project!.id, resourceType: 'constraint', resourceId: `${body.schema}.${params.table}`, metadata: { type: body.type } });
    return reply.code(201).send({ data: { sql }, error: null });
  });

  app.post('/projects/:projectId/database/tables/:table/indexes', write, async (req, reply) => {
    const params = z.object({ table: z.string().min(1) }).parse(req.params);
    const body = z.object({
      schema: z.string().default('public'),
      name: z.string().max(63).optional(),
      columns: z.array(z.string()).min(1),
      unique: z.boolean().default(false),
      method: z.enum(['btree', 'hash', 'gin', 'gist', 'brin', 'ivfflat', 'hnsw']).default('btree'),
    }).parse(req.body);

    const indexName = quoteIdent(body.name ?? `${params.table}_${body.columns.join('_')}_idx`);
    const sql = `CREATE ${body.unique ? 'UNIQUE ' : ''}INDEX ${indexName} ON ${quoteQualified(body.schema, params.table)} ` +
                `USING ${body.method} (${body.columns.map(quoteIdent).join(', ')})`;

    const pool = await poolManager.get(req.project!.id);
    await pool.query(sql).catch((err) => { throw new ApiError('DATABASE_ERROR', (err as Error).message); });

    void audit(req, { action: 'INDEX_CREATED', projectId: req.project!.id, resourceType: 'index', resourceId: body.name ?? indexName });
    return reply.code(201).send({ data: { sql }, error: null });
  });

  app.delete('/projects/:projectId/database/indexes/:index', write, async (req) => {
    const params = z.object({ index: z.string().min(1) }).parse(req.params);
    const schema = (req.query as { schema?: string }).schema ?? 'public';
    const pool = await poolManager.get(req.project!.id);
    const sql = `DROP INDEX ${quoteQualified(schema, params.index)}`;
    await pool.query(sql).catch((err) => { throw new ApiError('DATABASE_ERROR', (err as Error).message); });
    return { data: { dropped: true, sql }, error: null };
  });

  // ------------------------------------------------------------ RLS policies

  app.post('/projects/:projectId/database/tables/:table/policies', admin, async (req, reply) => {
    const params = z.object({ table: z.string().min(1) }).parse(req.params);
    const body = z.object({
      schema: z.string().default('public'),
      name: z.string().min(1).max(63),
      command: z.enum(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL']).default('SELECT'),
      roles: z.array(z.string().max(63)).default(['public']),
      using: z.string().max(1000).optional(),
      check: z.string().max(1000).optional(),
    }).parse(req.body);

    if (body.command === 'INSERT' && !body.check) {
      throw new ApiError('VALIDATION_ERROR', 'An INSERT policy needs a WITH CHECK expression');
    }
    if (body.command !== 'INSERT' && !body.using) {
      throw new ApiError('VALIDATION_ERROR', 'This policy needs a USING expression');
    }

    const sql = [
      `CREATE POLICY ${quoteIdent(body.name)} ON ${quoteQualified(body.schema, params.table)}`,
      `FOR ${body.command}`,
      `TO ${body.roles.map((r) => (r === 'public' ? 'public' : quoteIdent(r))).join(', ')}`,
      body.using ? `USING (${body.using})` : '',
      body.check ? `WITH CHECK (${body.check})` : '',
    ].filter(Boolean).join('\n');

    const pool = await poolManager.get(req.project!.id);
    await pool.query(sql).catch((err) => { throw new ApiError('DATABASE_ERROR', (err as Error).message); });

    void audit(req, { action: 'POLICY_CREATED', projectId: req.project!.id, resourceType: 'policy', resourceId: `${body.schema}.${params.table}.${body.name}`, metadata: { command: body.command } });
    return reply.code(201).send({ data: { sql }, error: null });
  });

  app.delete('/projects/:projectId/database/tables/:table/policies/:policy', admin, async (req) => {
    const params = z.object({ table: z.string().min(1), policy: z.string().min(1) }).parse(req.params);
    const schema = (req.query as { schema?: string }).schema ?? 'public';
    const pool = await poolManager.get(req.project!.id);
    const sql = `DROP POLICY ${quoteIdent(params.policy)} ON ${quoteQualified(schema, params.table)}`;
    await pool.query(sql).catch((err) => { throw new ApiError('DATABASE_ERROR', (err as Error).message); });

    void audit(req, { action: 'POLICY_DELETED', projectId: req.project!.id, resourceType: 'policy', resourceId: params.policy });
    return { data: { dropped: true, sql }, error: null };
  });

  /** Turns realtime on or off for one table by attaching the NOTIFY trigger. */
  app.post('/projects/:projectId/database/tables/:table/realtime', write, async (req) => {
    const params = z.object({ table: z.string().min(1) }).parse(req.params);
    const body = z.object({ schema: z.string().default('public'), enabled: z.boolean() }).parse(req.body);
    const pool = await poolManager.get(req.project!.id);
    const trigger = quoteIdent(`kairos_realtime_${params.table}`);
    const qualified = quoteQualified(body.schema, params.table);

    const sql = body.enabled
      ? `CREATE TRIGGER ${trigger} AFTER INSERT OR UPDATE OR DELETE ON ${qualified}
           FOR EACH ROW EXECUTE FUNCTION public.kairos_notify_change()`
      : `DROP TRIGGER IF EXISTS ${trigger} ON ${qualified}`;

    await pool.query(sql).catch((err) => { throw new ApiError('DATABASE_ERROR', (err as Error).message); });
    return { data: { enabled: body.enabled, sql }, error: null };
  });
}
