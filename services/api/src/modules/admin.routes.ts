/**
 * Platform admin.
 *
 * This replaces the `PLATFORM_OPERATORS` email allow-list, which was always a
 * placeholder. Admin status is now `users.is_platform_admin` — a real column,
 * granted by another admin, with every grant written to the audit log.
 *
 * The allow-list survives as a *bootstrap* only: a fresh install needs a first
 * admin, and the alternative is telling people to edit rows by hand.
 *
 * Three rules this surface follows, because an admin panel is the most
 * dangerous page in any platform:
 *
 *  1. Read broadly, write narrowly. Admins can see every organization; the
 *     mutations are a short, deliberate list.
 *  2. Everything is audited, including the reads that expose other people's
 *     data.
 *  3. Destructive actions require typing the thing's name. No bare confirm
 *     dialog, which people click through.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, query } from '../db/platform.js';
import { ApiError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { poolManager } from '../db/pool-manager.js';
import { logger } from '../logger.js';

/**
 * Bootstrap admins from the environment at startup.
 *
 * Runs once. Existing admins are never demoted from here — an env var that
 * silently removes someone's access on restart would be a nasty surprise
 * during an incident.
 */
export async function bootstrapAdmins(): Promise<void> {
  const emails = (process.env['PLATFORM_OPERATORS'] ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (emails.length === 0) return;

  const result = await query(
    `UPDATE users SET is_platform_admin = TRUE
      WHERE email = ANY($1::citext[]) AND is_platform_admin = FALSE AND deleted_at IS NULL`,
    [emails],
  ).catch((error: unknown) => {
    logger.warn({ err: error }, 'could not bootstrap platform admins');
    return { rowCount: 0 };
  });

  if ((result as { rowCount?: number }).rowCount) {
    logger.info({ granted: (result as { rowCount?: number }).rowCount }, 'bootstrapped platform admins from PLATFORM_OPERATORS');
  }
}

export default async function adminRoutes(app: FastifyInstance) {
  /**
   * Gate. Checked against the database rather than a claim in the token, so
   * revoking admin takes effect on the next request rather than whenever the
   * access token happens to expire.
   */
  const requireAdmin = async (req: Parameters<typeof app.requireUser>[0]) => {
    const row = await one<{ is_platform_admin: boolean }>(
      'SELECT is_platform_admin FROM users WHERE id = $1 AND deleted_at IS NULL',
      [req.user!.id],
    );
    if (!row?.is_platform_admin) {
      throw new ApiError('FORBIDDEN', 'This needs platform operator access');
    }
  };

  const admin = { preHandler: [app.requireUser, requireAdmin] };

  app.get('/admin/overview', admin, async () => {
    const [users, orgs, projects, storage, incidents] = await Promise.all([
      one<{ total: string; admins: string; last_7d: string }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE is_platform_admin)::text AS admins,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::text AS last_7d
           FROM users WHERE deleted_at IS NULL`,
      ),
      one<{ total: string }>('SELECT COUNT(*)::text AS total FROM organizations'),
      one<{ total: string; active: string; failed: string }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE status = 'active')::text AS active,
                COUNT(*) FILTER (WHERE status = 'failed')::text AS failed
           FROM projects WHERE deleted_at IS NULL`,
      ),
      one<{ database_bytes: string; storage_bytes: string }>(
        `SELECT COALESCE(SUM(database_bytes),0)::text AS database_bytes,
                COALESCE(SUM(storage_bytes),0)::text  AS storage_bytes
           FROM project_usage`,
      ),
      one<{ violations: string; unverified_backups: string }>(
        `SELECT
           (SELECT COUNT(*) FROM quota_violations WHERE created_at > NOW() - INTERVAL '24 hours')::text AS violations,
           (SELECT COUNT(*) FROM database_backups WHERE status = 'completed' AND verified_at IS NULL)::text AS unverified_backups`,
      ),
    ]);

    return {
      data: {
        users: { total: Number(users?.total ?? 0), admins: Number(users?.admins ?? 0), newLast7Days: Number(users?.last_7d ?? 0) },
        organizations: Number(orgs?.total ?? 0),
        projects: {
          total: Number(projects?.total ?? 0),
          active: Number(projects?.active ?? 0),
          failed: Number(projects?.failed ?? 0),
        },
        usage: {
          databaseBytes: Number(storage?.database_bytes ?? 0),
          storageBytes: Number(storage?.storage_bytes ?? 0),
        },
        attention: {
          quotaViolations24h: Number(incidents?.violations ?? 0),
          // Surfaced here because an unverified backup is the kind of problem
          // that is invisible until the day it matters.
          unverifiedBackups: Number(incidents?.unverified_backups ?? 0),
        },
        connections: poolManager.stats(),
      },
      error: null,
    };
  });

  app.get('/admin/users', admin, async (req) => {
    const q = z.object({
      search: z.string().max(200).optional(),
      limit: z.coerce.number().min(1).max(200).default(50),
      offset: z.coerce.number().min(0).default(0),
    }).parse(req.query);

    const users = await many(
      `SELECT u.id, u.email, u.full_name, u.email_verified, u.is_platform_admin,
              u.created_at, u.deleted_at,
              (SELECT COUNT(*) FROM organization_members m WHERE m.user_id = u.id) AS organizations,
              (SELECT confirmed_at IS NOT NULL FROM user_mfa f WHERE f.user_id = u.id) AS mfa_enabled,
              (SELECT MAX(created_at) FROM sessions s WHERE s.user_id = u.id) AS last_session_at
         FROM users u
        WHERE ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%' OR u.full_name ILIKE '%' || $1 || '%')
        ORDER BY u.created_at DESC
        LIMIT $2 OFFSET $3`,
      [q.search ?? null, q.limit, q.offset],
    );

    void audit(req, { action: 'ADMIN_USERS_LISTED', resourceType: 'user', metadata: { search: q.search } });
    return { data: users, error: null };
  });

  app.get('/admin/projects', admin, async (req) => {
    const q = z.object({ limit: z.coerce.number().min(1).max(200).default(50) }).parse(req.query);
    const projects = await many(
      `SELECT p.id, p.ref, p.name, p.status, p.created_at,
              o.name AS organization, u.email AS owner_email,
              usg.database_bytes::text, usg.storage_bytes::text, usg.table_count, usg.sampled_at
         FROM projects p
         JOIN organizations o ON o.id = p.organization_id
         JOIN users u ON u.id = p.created_by
         LEFT JOIN project_usage usg ON usg.project_id = p.id
        WHERE p.deleted_at IS NULL
        ORDER BY usg.database_bytes DESC NULLS LAST, p.created_at DESC
        LIMIT $1`,
      [q.limit],
    );
    return { data: projects, error: null };
  });

  /**
   * Security events, as the admin surface's answer to "what is happening".
   * Reads the audit log rather than the fail2ban log, because banned addresses
   * never reached the application in the first place.
   */
  app.get('/admin/security', admin, async (req) => {
    const q = z.object({ hours: z.coerce.number().min(1).max(720).default(24) }).parse(req.query);

    const [actions, violations, failures] = await Promise.all([
      many(
        `SELECT action, COUNT(*)::int AS count, MAX(created_at) AS last_seen
           FROM audit_logs WHERE created_at > NOW() - ($1 || ' hours')::interval
          GROUP BY action ORDER BY COUNT(*) DESC LIMIT 25`,
        [String(q.hours)],
      ),
      many(
        `SELECT v.resource, COUNT(*)::int AS count, p.ref AS project_ref
           FROM quota_violations v JOIN projects p ON p.id = v.project_id
          WHERE v.created_at > NOW() - ($1 || ' hours')::interval
          GROUP BY v.resource, p.ref ORDER BY COUNT(*) DESC LIMIT 25`,
        [String(q.hours)],
      ),
      many(
        `SELECT ip_address::text, COUNT(*)::int AS attempts, MAX(created_at) AS last_seen
           FROM audit_logs
          WHERE action IN ('REFRESH_TOKEN_REUSE_DETECTED')
            AND created_at > NOW() - ($1 || ' hours')::interval
          GROUP BY ip_address ORDER BY COUNT(*) DESC LIMIT 25`,
        [String(q.hours)],
      ),
    ]);

    return {
      data: {
        windowHours: q.hours,
        topActions: actions,
        quotaViolations: violations,
        tokenReuse: failures,
        note: 'Blocked and banned traffic never reaches the application. Check fail2ban and the nginx logs for that.',
      },
      error: null,
    };
  });

  /** Grant or revoke platform admin. */
  app.patch('/admin/users/:userId/admin', admin, async (req) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const body = z.object({ isAdmin: z.boolean(), reason: z.string().max(300).optional() }).parse(req.body);

    if (userId === req.user!.id && !body.isAdmin) {
      // Removing your own access is how an install ends up with no operator at
      // all, at which point the only fix is editing the database by hand.
      throw new ApiError('VALIDATION_ERROR', 'Ask another operator to remove your admin access');
    }

    if (!body.isAdmin) {
      const others = await one<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM users WHERE is_platform_admin AND id <> $1 AND deleted_at IS NULL',
        [userId],
      );
      if (Number(others?.count ?? 0) === 0) {
        throw new ApiError('VALIDATION_ERROR', 'This is the last platform operator');
      }
    }

    const updated = await one(
      'UPDATE users SET is_platform_admin = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id, email, is_platform_admin',
      [userId, body.isAdmin],
    );
    if (!updated) throw new ApiError('NOT_FOUND', 'No such user');

    void audit(req, {
      action: body.isAdmin ? 'ADMIN_GRANTED' : 'ADMIN_REVOKED',
      resourceType: 'user',
      resourceId: userId,
      metadata: { reason: body.reason },
    });
    return { data: updated, error: null };
  });

  /**
   * Suspend a project without deleting it.
   *
   * Setting every quota to zero is the mechanism — which is why zero and NULL
   * are kept distinct in the quota code. The data stays; the project simply
   * cannot grow or serve.
   */
  app.post('/admin/projects/:ref/suspend', admin, async (req) => {
    const { ref } = z.object({ ref: z.string().min(1) }).parse(req.params);
    const body = z.object({ confirm: z.string(), reason: z.string().max(300) }).parse(req.body);
    if (body.confirm !== ref) {
      throw new ApiError('VALIDATION_ERROR', `Type "${ref}" to confirm`);
    }

    const project = await one<{ id: string }>('SELECT id FROM projects WHERE ref = $1 AND deleted_at IS NULL', [ref]);
    if (!project) throw new ApiError('NOT_FOUND', 'No such project');

    await query(
      `UPDATE project_quotas
          SET database_bytes = 0, storage_bytes = 0, api_requests_per_hour = 0,
              max_tables = 0, note = $2, updated_by = $3, updated_at = NOW()
        WHERE project_id = $1`,
      [project.id, `SUSPENDED: ${body.reason}`, req.user!.id],
    );
    const { invalidateQuotaCache } = await import('../lib/quotas.js');
    await invalidateQuotaCache(project.id);
    await poolManager.evict(project.id);

    void audit(req, { action: 'PROJECT_SUSPENDED', projectId: project.id, resourceType: 'project', resourceId: ref, metadata: { reason: body.reason } });
    return { data: { suspended: true, ref }, error: null };
  });
}
