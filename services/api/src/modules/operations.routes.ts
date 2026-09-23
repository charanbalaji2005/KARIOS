import { vetOutboundUrl } from '../lib/ssrf.js';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, query } from '../db/platform.js';
import { poolManager } from '../db/pool-manager.js';
import { encrypt, randomToken } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { classifyStatement } from '../lib/sql.js';
import { backupQueue, webhookQueue } from './events.js';

const WEBHOOK_EVENTS = [
  'database.insert', 'database.update', 'database.delete',
  'storage.upload', 'storage.delete', 'user.created', 'user.deleted',
] as const;

export default async function operationsRoutes(app: FastifyInstance) {
  const readSettings = { preHandler: [app.requireProject('settings.read')] };
  const writeSettings = { preHandler: [app.requireProject('settings.write')] };
  const readLogs = { preHandler: [app.requireProject('logs.read')] };

  // ------------------------------------------------------------------ webhooks

  app.get('/projects/:projectId/webhooks', readSettings, async (req) => {
    const rows = await many(
      `SELECT w.id, w.name, w.url, w.events, w.active, w.created_at,
              (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND NOT d.succeeded) AS failed_deliveries
         FROM webhooks w WHERE w.project_id = $1 ORDER BY w.created_at DESC`,
      [req.project!.id],
    );
    return { data: rows, error: null };
  });

  app.post('/projects/:projectId/webhooks', writeSettings, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).max(80),
      url: z.string().url(),
      events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
    }).parse(req.body);

    // Checked at creation so the user gets an immediate, actionable error
    // rather than a silently failing webhook. The worker re-checks on every
    // delivery, because DNS can change after this point — this call is for the
    // user's benefit, that one is the security boundary.
    await vetOutboundUrl(body.url);

    const secret = randomToken(32);
    const row = await one<{ id: string }>(
      `INSERT INTO webhooks (project_id, name, url, events, secret_enc)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [req.project!.id, body.name, body.url, body.events, encrypt(secret)],
    );

    void audit(req, { action: 'WEBHOOK_CREATED', projectId: req.project!.id, resourceType: 'webhook', resourceId: row!.id });
    // The signing secret is shown once, like an API key.
    return reply.code(201).send({ data: { id: row!.id, ...body, secret }, error: null });
  });

  app.delete('/projects/:projectId/webhooks/:webhookId', writeSettings, async (req) => {
    const { webhookId } = z.object({ webhookId: z.string().uuid() }).parse(req.params);
    await query('DELETE FROM webhooks WHERE id = $1 AND project_id = $2', [webhookId, req.project!.id]);
    void audit(req, { action: 'WEBHOOK_DELETED', projectId: req.project!.id, resourceType: 'webhook', resourceId: webhookId });
    return { data: { deleted: true }, error: null };
  });

  app.get('/projects/:projectId/webhooks/:webhookId/deliveries', readLogs, async (req) => {
    const { webhookId } = z.object({ webhookId: z.string().uuid() }).parse(req.params);
    const rows = await many(
      `SELECT d.id, d.event, d.attempt, d.status_code, d.succeeded, d.error, d.created_at
         FROM webhook_deliveries d
         JOIN webhooks w ON w.id = d.webhook_id
        WHERE d.webhook_id = $1 AND w.project_id = $2
        ORDER BY d.created_at DESC LIMIT 100`,
      [webhookId, req.project!.id],
    );
    return { data: rows, error: null };
  });

  app.post('/projects/:projectId/webhooks/:webhookId/test', writeSettings, async (req) => {
    const { webhookId } = z.object({ webhookId: z.string().uuid() }).parse(req.params);
    const hook = await one('SELECT id FROM webhooks WHERE id = $1 AND project_id = $2', [webhookId, req.project!.id]);
    if (!hook) throw new ApiError('NOT_FOUND', 'Webhook not found');

    await webhookQueue.add('deliver', {
      projectId: req.project!.id,
      event: 'database.insert',
      payload: { test: true, sentAt: new Date().toISOString() },
      onlyWebhookId: webhookId,
    }, { attempts: 1 });

    return { data: { queued: true }, error: null };
  });

  // ---------------------------------------------------------------- migrations

  app.get('/projects/:projectId/migrations', { preHandler: [app.requireProject('database.read')] }, async (req) => {
    const rows = await many(
      `SELECT id, name, checksum, applied_at, created_at FROM project_migrations
        WHERE project_id = $1 ORDER BY created_at`,
      [req.project!.id],
    );
    return { data: rows, error: null };
  });

  app.post('/projects/:projectId/migrations', { preHandler: [app.requireProject('database.admin')] }, async (req, reply) => {
    const body = z.object({
      name: z.string().regex(/^[a-z0-9_]{3,80}$/, 'Use lowercase letters, numbers and underscores'),
      up: z.string().min(1).max(200_000),
      down: z.string().max(200_000).optional(),
    }).parse(req.body);

    const checksum = createHash('sha256').update(body.up).digest('hex');
    const existing = await one('SELECT id FROM project_migrations WHERE project_id = $1 AND name = $2', [req.project!.id, body.name]);
    if (existing) throw new ApiError('CONFLICT', `A migration named ${body.name} already exists`);

    const row = await one(
      `INSERT INTO project_migrations (project_id, name, up_sql, down_sql, checksum)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, name, created_at`,
      [req.project!.id, body.name, body.up, body.down ?? null, checksum],
    );
    return reply.code(201).send({ data: row, error: null });
  });

  /** Preview: what a migration will do, and whether any of it is destructive. */
  app.get('/projects/:projectId/migrations/:migrationId/preview', { preHandler: [app.requireProject('database.read')] }, async (req) => {
    const { migrationId } = z.object({ migrationId: z.string().uuid() }).parse(req.params);
    const row = await one<{ up_sql: string; name: string }>(
      'SELECT up_sql, name FROM project_migrations WHERE id = $1 AND project_id = $2',
      [migrationId, req.project!.id],
    );
    if (!row) throw new ApiError('NOT_FOUND', 'Migration not found');

    const statements = row.up_sql.split(';').map((s) => s.trim()).filter(Boolean);
    const classified = statements.map((sql) => ({ sql, kind: classifyStatement(sql) }));
    return {
      data: {
        name: row.name,
        statements: classified,
        destructive: classified.some((s) => s.kind === 'destructive'),
      },
      error: null,
    };
  });

  app.post('/projects/:projectId/migrations/:migrationId/apply', { preHandler: [app.requireProject('database.admin')] }, async (req) => {
    const { migrationId } = z.object({ migrationId: z.string().uuid() }).parse(req.params);
    const row = await one<{ id: string; name: string; up_sql: string; checksum: string; applied_at: string | null }>(
      'SELECT id, name, up_sql, checksum, applied_at FROM project_migrations WHERE id = $1 AND project_id = $2',
      [migrationId, req.project!.id],
    );
    if (!row) throw new ApiError('NOT_FOUND', 'Migration not found');
    if (row.applied_at) throw new ApiError('CONFLICT', 'This migration has already been applied');

    // Tamper check: the SQL must be exactly what was reviewed.
    if (createHash('sha256').update(row.up_sql).digest('hex') !== row.checksum) {
      throw new ApiError('VALIDATION_ERROR', 'This migration has been modified since it was created');
    }

    const pool = await poolManager.get(req.project!.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(row.up_sql);
      await client.query(
        'INSERT INTO public.schema_migrations (name, checksum) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING',
        [row.name, row.checksum],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new ApiError('DATABASE_ERROR', `Migration failed and was rolled back: ${(err as Error).message}`);
    } finally {
      client.release();
    }

    await query('UPDATE project_migrations SET applied_at = NOW() WHERE id = $1', [row.id]);
    void audit(req, { action: 'MIGRATION_APPLIED', projectId: req.project!.id, resourceType: 'migration', resourceId: row.name });
    return { data: { applied: true, name: row.name }, error: null };
  });

  app.post('/projects/:projectId/migrations/:migrationId/rollback', { preHandler: [app.requireProject('database.admin')] }, async (req) => {
    const { migrationId } = z.object({ migrationId: z.string().uuid() }).parse(req.params);
    const row = await one<{ name: string; down_sql: string | null; applied_at: string | null }>(
      'SELECT name, down_sql, applied_at FROM project_migrations WHERE id = $1 AND project_id = $2',
      [migrationId, req.project!.id],
    );
    if (!row) throw new ApiError('NOT_FOUND', 'Migration not found');
    if (!row.applied_at) throw new ApiError('CONFLICT', 'This migration has not been applied');
    if (!row.down_sql) throw new ApiError('VALIDATION_ERROR', 'This migration has no down script, so it cannot be rolled back automatically');

    const pool = await poolManager.get(req.project!.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(row.down_sql);
      await client.query('DELETE FROM public.schema_migrations WHERE name = $1', [row.name]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new ApiError('DATABASE_ERROR', `Rollback failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }

    await query('UPDATE project_migrations SET applied_at = NULL WHERE id = $1', [migrationId]);
    void audit(req, { action: 'MIGRATION_ROLLED_BACK', projectId: req.project!.id, resourceType: 'migration', resourceId: row.name });
    return { data: { rolledBack: true }, error: null };
  });

  // ------------------------------------------------------------------- backups

  app.get('/projects/:projectId/backups', readSettings, async (req) => {
    const rows = await many(
      `SELECT id, status, size_bytes, error, started_at, finished_at, created_at
         FROM database_backups WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.project!.id],
    );
    return { data: rows, error: null };
  });

  app.post('/projects/:projectId/backups', writeSettings, async (req, reply) => {
    const row = await one<{ id: string }>(
      `INSERT INTO database_backups (project_id, created_by) VALUES ($1,$2) RETURNING id`,
      [req.project!.id, req.user!.id],
    );
    await backupQueue.add('dump', { backupId: row!.id, projectId: req.project!.id, projectRef: req.project!.ref }, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 10_000 },
    });

    void audit(req, { action: 'BACKUP_REQUESTED', projectId: req.project!.id, resourceType: 'backup', resourceId: row!.id });
    return reply.code(202).send({ data: { id: row!.id, status: 'pending' }, error: null });
  });

  // ------------------------------------------------------- logs and telemetry

  app.get('/projects/:projectId/logs/audit', readLogs, async (req) => {
    const q = z.object({ limit: z.coerce.number().min(1).max(200).default(100) }).parse(req.query);
    const rows = await many(
      `SELECT a.id, a.action, a.resource_type, a.resource_id, a.metadata, a.ip_address, a.created_at,
              u.email AS actor_email
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.project_id = $1 ORDER BY a.created_at DESC LIMIT $2`,
      [req.project!.id, q.limit],
    );
    return { data: rows, error: null };
  });

  /** Overview metrics, computed live rather than stored as fixtures. */
  app.get('/projects/:projectId/usage', { preHandler: [app.requireProject('project.read')] }, async (req) => {
    const pool = await poolManager.get(req.project!.id);
    const [size, tables, storage, queries] = await Promise.all([
      pool.query<{ bytes: string }>('SELECT pg_database_size(current_database()) AS bytes'),
      pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema','auth')`),
      one<{ bytes: string; objects: string }>(
        `SELECT COALESCE(SUM(o.size),0) AS bytes, COUNT(o.id) AS objects
           FROM storage_objects o JOIN storage_buckets b ON b.id = o.bucket_id
          WHERE b.project_id = $1`, [req.project!.id]),
      many<{ bucket: string; total: string; failed: string; avg_ms: string }>(
        `SELECT date_trunc('hour', created_at)::text AS bucket,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE NOT succeeded) AS failed,
                AVG(duration_ms) AS avg_ms
           FROM query_logs
          WHERE project_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
          GROUP BY 1 ORDER BY 1`, [req.project!.id]),
    ]);

    return {
      data: {
        databaseBytes: Number(size.rows[0]?.bytes ?? 0),
        tableCount: tables.rows[0]?.count ?? 0,
        storageBytes: Number(storage?.bytes ?? 0),
        storageObjects: Number(storage?.objects ?? 0),
        queriesLast24h: queries.map((q) => ({
          hour: q.bucket,
          total: Number(q.total),
          failed: Number(q.failed),
          avgMs: Number(q.avg_ms),
        })),
      },
      error: null,
    };
  });

  /** TypeScript type generation straight from the live catalog. */
  app.get('/projects/:projectId/types', { preHandler: [app.requireProject('database.read')] }, async (req, reply) => {
    const pool = await poolManager.get(req.project!.id);
    const { rows } = await pool.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; has_default: boolean }>(`
      SELECT c.table_name, c.column_name, c.data_type, c.is_nullable,
             (c.column_default IS NOT NULL) AS has_default
        FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
       WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       ORDER BY c.table_name, c.ordinal_position`);

    const tsType = (pgType: string): string => {
      if (/^(integer|bigint|smallint|numeric|real|double precision|money)$/.test(pgType)) return 'number';
      if (pgType === 'boolean') return 'boolean';
      if (/json/.test(pgType)) return 'Record<string, unknown>';
      if (pgType === 'ARRAY') return 'unknown[]';
      return 'string';
    };

    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = grouped.get(row.table_name) ?? [];
      list.push(row);
      grouped.set(row.table_name, list);
    }

    const body = [...grouped.entries()].map(([table, cols]) => {
      const rowType = cols.map((c) => `          ${c.column_name}: ${tsType(c.data_type)}${c.is_nullable === 'YES' ? ' | null' : ''};`).join('\n');
      const insertType = cols.map((c) => {
        const optional = c.is_nullable === 'YES' || c.has_default ? '?' : '';
        return `          ${c.column_name}${optional}: ${tsType(c.data_type)}${c.is_nullable === 'YES' ? ' | null' : ''};`;
      }).join('\n');
      return `      ${table}: {\n        Row: {\n${rowType}\n        };\n        Insert: {\n${insertType}\n        };\n        Update: Partial<Database['public']['Tables']['${table}']['Insert']>;\n      };`;
    }).join('\n');

    const output = `// Generated by KairosDB. Do not edit by hand.\n\nexport interface Database {\n  public: {\n    Tables: {\n${body}\n    };\n  };\n}\n`;
    reply.header('content-type', 'text/plain; charset=utf-8');
    return reply.send(output);
  });
}
