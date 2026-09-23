import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, query, transaction } from '../db/platform.js';
import { poolManager } from '../db/pool-manager.js';
import { encrypt, decrypt, projectRef, randomToken, sha256 } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { logger } from '../logger.js';
import { connectionStrings, deprovisionProjectDatabase, provisionProjectDatabase, storeConnection } from './provisioner.js';
import { getQuotas, getUsage, initialiseQuotas, invalidateQuotaCache, summarise } from '../lib/quotas.js';
import { env } from '../env.js';

const createOrgBody = z.object({ name: z.string().min(1).max(120) });
const createProjectBody = z.object({
  name: z.string().min(1).max(120),
  organizationId: z.string().uuid(),
  region: z.string().max(40).default('local'),
});

/** Keys are prefixed so they are recognisable in logs and revocable by sight. */
function mintKey(kind: 'anon' | 'service_role' | 'secret', ref: string) {
  const raw = `krs_${kind === 'service_role' ? 'srv' : kind === 'anon' ? 'anon' : 'sec'}_${ref}_${randomToken(24)}`;
  return { raw, prefix: raw.slice(0, 16), hash: sha256(raw) };
}

export default async function projectRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ organizations

  app.post('/organizations', { preHandler: [app.requireUser] }, async (req, reply) => {
    const body = createOrgBody.parse(req.body);
    const slug = `${body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}-${randomToken(3).toLowerCase().slice(0, 5)}`;

    const org = await transaction(async (client) => {
      const created = await client.query<{ id: string; name: string; slug: string }>(
        'INSERT INTO organizations (name, slug, created_by) VALUES ($1,$2,$3) RETURNING id, name, slug',
        [body.name, slug, req.user!.id],
      );
      await client.query(
        `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'owner')`,
        [created.rows[0]!.id, req.user!.id],
      );
      return created.rows[0]!;
    });

    void audit(req, { action: 'ORGANIZATION_CREATED', organizationId: org.id, resourceType: 'organization', resourceId: org.id });
    return reply.code(201).send({ data: org, error: null });
  });

  app.get('/organizations', { preHandler: [app.requireUser] }, async (req) => {
    const rows = await many(
      `SELECT o.id, o.name, o.slug, om.role, o.created_at,
              (SELECT COUNT(*) FROM projects p WHERE p.organization_id = o.id AND p.deleted_at IS NULL) AS project_count
         FROM organizations o
         JOIN organization_members om ON om.organization_id = o.id
        WHERE om.user_id = $1 AND o.deleted_at IS NULL
        ORDER BY o.created_at`,
      [req.user!.id],
    );
    return { data: rows, error: null };
  });

  // ----------------------------------------------------------------- projects

  app.get('/projects', { preHandler: [app.requireUser] }, async (req) => {
    const rows = await many(
      `SELECT DISTINCT p.id, p.ref, p.name, p.status, p.region, p.organization_id, p.created_at
         FROM projects p
         LEFT JOIN project_members pm      ON pm.project_id = p.id AND pm.user_id = $1
         LEFT JOIN organization_members om ON om.organization_id = p.organization_id AND om.user_id = $1
        WHERE p.deleted_at IS NULL AND (pm.user_id IS NOT NULL OR om.user_id IS NOT NULL)
        ORDER BY p.created_at DESC`,
      [req.user!.id],
    );
    return { data: rows, error: null };
  });

  /**
   * Project creation is the one flow that touches every layer: metadata row,
   * real database provisioning, key issuance. It runs inline (not queued) so the
   * dashboard can show the keys immediately; failures roll the project into a
   * `failed` state rather than leaving a half-built tenant behind.
   */
  app.post('/projects', { preHandler: [app.requireUser] }, async (req, reply) => {
    const body = createProjectBody.parse(req.body);

    const membership = await one<{ role: string }>(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [body.organizationId, req.user!.id],
    );
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new ApiError('FORBIDDEN', 'Only organization owners and admins can create projects');
    }

    const ref = projectRef();
    const jwtSecret = randomToken(32);

    const project = await transaction(async (client) => {
      const created = await client.query<{ id: string; ref: string; name: string }>(
        `INSERT INTO projects (organization_id, name, ref, region, status, jwt_secret_enc, created_by)
         VALUES ($1,$2,$3,$4,'provisioning',$5,$6) RETURNING id, ref, name`,
        [body.organizationId, body.name, ref, body.region, encrypt(jwtSecret), req.user!.id],
      );
      await client.query(
        `INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,'owner')`,
        [created.rows[0]!.id, req.user!.id],
      );
      return created.rows[0]!;
    });

    try {
      const result = await provisionProjectDatabase(ref);
      await storeConnection(project.id, result);

      const anon = mintKey('anon', ref);
      const service = mintKey('service_role', ref);
      await query(
        `INSERT INTO api_keys (project_id, name, kind, prefix, key_hash, created_by)
         VALUES ($1,'anon','anon',$2,$3,$6), ($1,'service_role','service_role',$4,$5,$6)`,
        [project.id, anon.prefix, anon.hash, service.prefix, service.hash, req.user!.id],
      );
      await initialiseQuotas(project.id);
      await query(`UPDATE projects SET status = 'active', updated_at = NOW() WHERE id = $1`, [project.id]);

      // Default storage bucket so the storage UI is usable straight away.
      await query(
        `INSERT INTO storage_buckets (project_id, name, public) VALUES ($1,'public',TRUE)
         ON CONFLICT DO NOTHING`,
        [project.id],
      );

      void audit(req, {
        action: 'PROJECT_CREATED',
        organizationId: body.organizationId,
        projectId: project.id,
        resourceType: 'project',
        resourceId: project.id,
        metadata: { ref },
      });

      return reply.code(201).send({
        data: {
          id: project.id,
          ref,
          name: project.name,
          status: 'active',
          apiUrl: `${env.API_URL}/rest/v1`,
          realtimeUrl: `${env.API_URL.replace(/^http/, 'ws')}/realtime/v1`,
          storageUrl: `${env.API_URL}/storage/v1`,
          // Shown exactly once. After this only the prefix is retrievable.
          keys: { anon: anon.raw, serviceRole: service.raw },
        },
        error: null,
      });
    } catch (err) {
      logger.error({ err, projectId: project.id }, 'Provisioning failed');
      await query(`UPDATE projects SET status = 'failed' WHERE id = $1`, [project.id]);
      throw new ApiError('PROVISIONING_ERROR', 'Could not provision the project database. The project was not created.');
    }
  });

  app.get('/projects/:projectId', { preHandler: [app.requireProject('project.read')] }, async (req) => {
    const project = await one(
      `SELECT id, ref, name, status, region, organization_id, created_at FROM projects WHERE id = $1`,
      [req.project!.id],
    );
    return { data: { ...project, role: req.project!.role }, error: null };
  });

  /** Connection strings. Passwords are only included when explicitly asked for by an owner. */
  app.get('/projects/:projectId/connection', { preHandler: [app.requireProject('settings.read')] }, async (req) => {
    const reveal = (req.query as { reveal?: string }).reveal === 'true';
    if (reveal && req.project!.role !== 'owner') {
      throw new ApiError('FORBIDDEN', 'Only the project owner can reveal the database password');
    }
    const conn = await poolManager.credentials(req.project!.id);
    const strings = connectionStrings(conn);

    if (reveal) {
      void audit(req, { action: 'DB_PASSWORD_REVEALED', projectId: req.project!.id, resourceType: 'project' });
      return {
        data: {
          ...strings,
          direct: strings.directWithPassword,
          psql: strings.psqlWithPassword,
          connectionString: strings.directWithPassword,
        },
        error: null,
      };
    }
    const { directWithPassword: _omit1, psqlWithPassword: _omit2, password: _omit3, ...safe } = strings;
    return { data: safe, error: null };
  });

  app.delete('/projects/:projectId', { preHandler: [app.requireProject('project.delete')] }, async (req) => {
    const body = z.object({ confirm: z.string() }).parse(req.body ?? {});
    if (body.confirm !== req.project!.ref) {
      throw new ApiError('VALIDATION_ERROR', `Type the project ref (${req.project!.ref}) to confirm deletion`);
    }

    const conn = await one<{ db_name: string; db_user: string }>(
      'SELECT db_name, db_user FROM database_connections WHERE project_id = $1',
      [req.project!.id],
    );

    await query(`UPDATE projects SET status = 'deleting' WHERE id = $1`, [req.project!.id]);
    await poolManager.evict(req.project!.id);
    if (conn) await deprovisionProjectDatabase(conn.db_name, conn.db_user);
    await query('UPDATE projects SET deleted_at = NOW(), status = $2 WHERE id = $1', [req.project!.id, 'paused']);

    void audit(req, { action: 'PROJECT_DELETED', projectId: req.project!.id, resourceType: 'project', resourceId: req.project!.id });
    return { data: { deleted: true }, error: null };
  });

  // ----------------------------------------------------------------- api keys

  app.get('/projects/:projectId/keys', { preHandler: [app.requireProject('keys.read')] }, async (req) => {
    const keys = await many(
      `SELECT id, name, kind, prefix, last_used_at, revoked_at, created_at
         FROM api_keys WHERE project_id = $1 ORDER BY created_at`,
      [req.project!.id],
    );
    return { data: keys, error: null };
  });

  app.post('/projects/:projectId/keys', { preHandler: [app.requireProject('keys.write')] }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).max(60),
      kind: z.enum(['anon', 'service_role', 'secret']).default('secret'),
    }).parse(req.body);

    const key = mintKey(body.kind, req.project!.ref);
    const row = await one<{ id: string }>(
      `INSERT INTO api_keys (project_id, name, kind, prefix, key_hash, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.project!.id, body.name, body.kind, key.prefix, key.hash, req.user!.id],
    );

    void audit(req, { action: 'API_KEY_CREATED', projectId: req.project!.id, resourceType: 'api_key', resourceId: row!.id, metadata: { kind: body.kind } });
    return reply.code(201).send({ data: { id: row!.id, name: body.name, kind: body.kind, key: key.raw }, error: null });
  });

  app.delete('/projects/:projectId/keys/:keyId', { preHandler: [app.requireProject('keys.write')] }, async (req) => {
    const { keyId } = z.object({ keyId: z.string().uuid() }).parse(req.params);
    const row = await one<{ id: string }>(
      'UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL RETURNING id',
      [keyId, req.project!.id],
    );
    if (!row) throw new ApiError('NOT_FOUND', 'API key not found or already revoked');

    void audit(req, { action: 'API_KEY_REVOKED', projectId: req.project!.id, resourceType: 'api_key', resourceId: keyId });
    return { data: { revoked: true }, error: null };
  });

  /** Mints a short-lived end-user token signed with the project's own secret. */
  app.post('/projects/:projectId/tokens', { preHandler: [app.requireProject('settings.write')] }, async (req) => {
    const body = z.object({ subject: z.string().uuid(), role: z.string().max(40).default('authenticated'), ttl: z.string().default('1h') }).parse(req.body);
    const row = await one<{ jwt_secret_enc: string; ref: string }>(
      'SELECT jwt_secret_enc, ref FROM projects WHERE id = $1',
      [req.project!.id],
    );
    if (!row?.jwt_secret_enc) throw new ApiError('INTERNAL_ERROR', 'This project has no signing key');

    const { signProjectToken } = await import('../lib/jwt.js');
    const token = await signProjectToken(decrypt(row.jwt_secret_enc), row.ref, body.subject, body.role, body.ttl);
    return { data: { token }, error: null };
  });
}
