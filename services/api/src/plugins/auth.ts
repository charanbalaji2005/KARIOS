import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { one } from '../db/platform.js';
import { sha256 } from '../lib/crypto.js';
import { securityEvent } from '../lib/security-log.js';
import { ApiError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { assertCan, type Permission, type Role } from '../lib/rbac.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; email: string; isPlatformAdmin: boolean };
    apiKey?: { id: string; projectId: string; kind: 'anon' | 'service_role' | 'secret' };
    /** Set by requireProject — the project in the route params and the caller's role in it. */
    project?: { id: string; ref: string; organizationId: string; role: Role };
  }
  interface FastifyInstance {
    requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireProject: (
      permission: Permission,
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireApiKey: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

interface ProjectAccessRow {
  id: string;
  ref: string;
  organization_id: string;
  status: string;
  rank: number;
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

/**
 * A project role is whichever is higher: explicit project membership, or the
 * role inherited from the organization. Org owners do not lose access to a
 * project just because nobody added them to it.
 */
const ROLE_RANK: Record<Role, number> = { viewer: 1, developer: 2, admin: 3, owner: 4 };
const RANK_ROLE: Record<number, Role> = { 1: 'viewer', 2: 'developer', 3: 'admin', 4: 'owner' };

const RANK_SQL = (alias: string) =>
  `COALESCE(CASE ${alias}.role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'developer' THEN 2 WHEN 'viewer' THEN 1 END, 0)`;

async function resolveProjectAccess(
  projectRefOrId: string,
  userId: string,
): Promise<{ row: ProjectAccessRow; role: Role } | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectRefOrId);
  const row = await one<ProjectAccessRow>(
    `SELECT p.id,
            p.ref,
            p.organization_id,
            p.status,
            GREATEST(${RANK_SQL('pm')}, ${RANK_SQL('om')}) AS rank
       FROM projects p
       LEFT JOIN project_members pm      ON pm.project_id = p.id AND pm.user_id = $2
       LEFT JOIN organization_members om ON om.organization_id = p.organization_id AND om.user_id = $2
      WHERE p.deleted_at IS NULL
        AND ${isUuid ? 'p.id = $1::uuid' : 'p.ref = $1'}`,
    [projectRefOrId, userId],
  );

  if (!row || row.rank < 1) return null;
  return { row, role: RANK_ROLE[row.rank]! };
}

export default fp(async function authPlugin(app: FastifyInstance) {
  /** Dashboard/session authentication. */
  app.decorate('requireUser', async (req: FastifyRequest) => {
    const token = bearer(req) ?? (req.cookies?.['kairos_access'] as string | undefined) ?? null;
    if (!token) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue');

    const claims = await verifyAccessToken(token);
    const user = await one<{ id: string; email: string; is_platform_admin: boolean }>(
      'SELECT id, email, is_platform_admin FROM users WHERE id = $1 AND deleted_at IS NULL',
      [claims.sub],
    );
    if (!user) throw new ApiError('INVALID_TOKEN', 'This account no longer exists');

    req.user = { id: user.id, email: user.email, isPlatformAdmin: user.is_platform_admin };
  });

  /**
   * Project-scoped authorization. Note what is *not* here: the project id is
   * read from the route, never from the body, and the role always comes from the
   * database rather than from anything the client sent.
   */
  app.decorate('requireProject', (permission: Permission) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.user) await app.requireUser(req, reply);
      const params = req.params as Record<string, string | undefined>;
      const ref = params.projectId ?? params.ref ?? params.projectRef;
      if (!ref) throw new ApiError('VALIDATION_ERROR', 'Missing project identifier in the request path');

      const access = await resolveProjectAccess(ref, req.user!.id);
      if (!access) throw new ApiError('PROJECT_NOT_FOUND', 'Project not found');

      assertCan(access.role, permission);
      req.project = {
        id: access.row.id,
        ref: access.row.ref,
        organizationId: access.row.organization_id,
        role: access.role,
      };
    };
  });

  /**
   * Data-plane authentication for the generated REST API and SDK:
   * `apikey:` header or Bearer key. anon keys get the caller's RLS-bound role,
   * service_role bypasses RLS and must never reach a browser.
   */
  app.decorate('requireApiKey', async (req: FastifyRequest) => {
    const raw = (req.headers['apikey'] as string | undefined) ?? bearer(req);
    if (!raw) throw new ApiError('AUTH_REQUIRED', 'Provide an API key via the apikey header');

    const row = await one<{ id: string; project_id: string; kind: 'anon' | 'service_role' | 'secret' }>(
      `SELECT id, project_id, kind FROM api_keys
        WHERE key_hash = $1 AND revoked_at IS NULL`,
      [sha256(raw)],
    );
    if (!row) {
      securityEvent('INVALID_API_KEY', {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        // Only the prefix. Logging the whole key would put a valid credential
        // in a log file the moment someone mistypes a character.
        detail: `prefix=${raw.slice(0, 12)}`,
      });
      throw new ApiError('INVALID_TOKEN', 'Invalid API key');
    }

    req.apiKey = { id: row.id, projectId: row.project_id, kind: row.kind };
    // Best-effort usage stamp; never block the request on it.
    void one('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1 RETURNING id', [row.id]).catch(() => null);
  });
});

export { ROLE_RANK };
