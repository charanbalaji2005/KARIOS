/**
 * Quota endpoints.
 *
 * Reading is open to any project member — a developer hitting a ceiling needs
 * to see the ceiling. Raising one is not: a project owner who could lift their
 * own limits has no limits, which defeats the point on shared hardware. The
 * write path therefore checks platform-operator status, not project role.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one } from '../db/platform.js';
import { ApiError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { env } from '../env.js';
import {
  DEFAULT_QUOTAS,
  getQuotas,
  getUsage,
  invalidateQuotaCache,
  summarise,
  type QuotaResource,
} from '../lib/quotas.js';

/**
 * Who may change a quota.
 *
 * `users.is_platform_admin`, checked against the database rather than a claim
 * in the token — so revoking admin takes effect on the next request rather
 * than whenever the access token happens to expire.
 *
 * The `PLATFORM_OPERATORS` env var this replaced now only bootstraps the first
 * admin at startup (see admin.routes.ts). It is kept as a fallback so an
 * install whose migration has not run yet is not locked out of its own quotas.
 */
async function isPlatformOperator(userId?: string, email?: string): Promise<boolean> {
  if (userId) {
    const row = await one<{ is_platform_admin: boolean }>(
      'SELECT is_platform_admin FROM users WHERE id = $1 AND deleted_at IS NULL',
      [userId],
    ).catch(() => null);
    if (row?.is_platform_admin) return true;
  }
  if (!email) return false;
  const operators = (process.env['PLATFORM_OPERATORS'] ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return operators.includes(email.toLowerCase());
}

const quotaPatch = z
  .object({
    database_bytes: z.number().int().min(0).nullable().optional(),
    storage_bytes: z.number().int().min(0).nullable().optional(),
    max_file_bytes: z.number().int().min(0).nullable().optional(),
    max_connections: z.number().int().min(0).max(1000).nullable().optional(),
    max_tables: z.number().int().min(0).max(100_000).nullable().optional(),
    api_requests_per_hour: z.number().int().min(0).nullable().optional(),
    realtime_connections: z.number().int().min(0).max(10_000).nullable().optional(),
    background_jobs_per_day: z.number().int().min(0).nullable().optional(),
    note: z.string().max(500).optional(),
  })
  .refine((body) => Object.keys(body).some((key) => key !== 'note'), {
    message: 'Provide at least one quota to change',
  });

export default async function quotaRoutes(app: FastifyInstance) {
  const read = { preHandler: [app.requireProject('project.read')] };

  app.get('/projects/:projectId/quotas', read, async (req) => {
    const [quotas, usage] = await Promise.all([getQuotas(req.project!.id), getUsage(req.project!.id)]);
    return {
      data: {
        quotas,
        usage,
        summary: summarise(quotas, usage),
        // Stated plainly so nobody reports a "wrong" number as a bug: the
        // byte figures come from the last sample, not from this instant.
        note: 'Database and storage figures come from the most recent sample, not a live count.',
      },
      error: null,
    };
  });

  app.get('/projects/:projectId/quotas/violations', read, async (req) => {
    const q = z.object({ limit: z.coerce.number().min(1).max(200).default(50) }).parse(req.query);
    const violations = await many(
      `SELECT resource, limit_value::text, actual::text, created_at
         FROM quota_violations WHERE project_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [req.project!.id, q.limit],
    );
    return { data: violations, error: null };
  });

  app.patch('/projects/:projectId/quotas', read, async (req) => {
    if (!(await isPlatformOperator(req.user?.id, req.user?.email))) {
      throw new ApiError(
        'FORBIDDEN',
        'Only a platform operator can change quotas. Ask whoever runs this server.',
      );
    }

    const body = quotaPatch.parse(req.body);
    const fields: QuotaResource[] = [
      'database_bytes', 'storage_bytes', 'max_file_bytes', 'max_connections',
      'max_tables', 'api_requests_per_hour', 'realtime_connections', 'background_jobs_per_day',
    ];

    const assignments: string[] = [];
    const values: unknown[] = [req.project!.id];
    for (const field of fields) {
      if (field in body) {
        values.push(body[field] ?? null);
        assignments.push(`${field} = $${values.length}`);
      }
    }
    values.push(body.note ?? null);
    assignments.push(`note = $${values.length}`);
    values.push(req.user!.id);
    assignments.push(`updated_by = $${values.length}`);
    assignments.push('updated_at = NOW()');

    const updated = await one(
      `UPDATE project_quotas SET ${assignments.join(', ')} WHERE project_id = $1 RETURNING *`,
      values,
    );
    if (!updated) throw new ApiError('NOT_FOUND', 'This project has no quota record');

    // Invalidate rather than wait for the 60s TTL: an operator lifting a limit
    // during an incident should not be told to wait a minute.
    await invalidateQuotaCache(req.project!.id);

    void audit(req, {
      action: 'QUOTAS_UPDATED',
      projectId: req.project!.id,
      resourceType: 'quota',
      resourceId: req.project!.ref,
      metadata: { changed: Object.keys(body), note: body.note },
    });

    return { data: updated, error: null };
  });

  /** The defaults a new project receives, so the dashboard can show them. */
  app.get('/quotas/defaults', { preHandler: [app.requireUser] }, async () => ({
    data: { defaults: DEFAULT_QUOTAS, maxUploadBytes: env.MAX_UPLOAD_BYTES },
    error: null,
  }));

  /**
   * Force a usage re-sample for one project. Useful straight after a bulk
   * delete, when the stored figure is stale in the direction that keeps a
   * project locked out of writes it should now be allowed.
   */
  app.post('/projects/:projectId/quotas/resample', read, async (req) => {
    const { sampleProjectUsage } = await import('../lib/usage-sampler.js');
    const usage = await sampleProjectUsage(req.project!.id, req.project!.ref);
    return { data: usage, error: null };
  });
}

export { isPlatformOperator };
