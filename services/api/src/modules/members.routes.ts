/**
 * Organization members and invitations.
 *
 * The invariant worth stating: **an invitation is an offer to a specific email
 * address, not a link that works for whoever holds it.** Acceptance checks that
 * the signed-in user's address matches the one invited. Otherwise a forwarded
 * email is a free membership, and "I sent it to the wrong person" becomes an
 * incident rather than an embarrassment.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, query, transaction } from '../db/platform.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import { env } from '../env.js';
import { ROLE_RANK } from '../plugins/auth.js';

const ROLES = ['owner', 'admin', 'developer', 'viewer'] as const;
const INVITE_TTL_DAYS = 7;

/**
 * Resolve the caller's role in an organization, in SQL, from their session —
 * never from the request body.
 */
async function requireOrgRole(
  organizationId: string,
  userId: string,
  minimum: (typeof ROLES)[number],
): Promise<(typeof ROLES)[number]> {
  const row = await one<{ role: (typeof ROLES)[number] }>(
    'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
    [organizationId, userId],
  );
  if (!row) throw new ApiError('NOT_FOUND', 'Organization not found');
  if ((ROLE_RANK[row.role] ?? 0) < (ROLE_RANK[minimum] ?? 0)) {
    throw new ApiError('FORBIDDEN', `This needs the ${minimum} role or higher`);
  }
  return row.role;
}

export default async function memberRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.requireUser] };

  app.get('/organizations/:orgId/members', auth, async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    await requireOrgRole(orgId, req.user!.id, 'viewer');

    const members = await many(
      `SELECT u.id, u.email, u.full_name, m.role, m.created_at AS joined_at
         FROM organization_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND u.deleted_at IS NULL
        ORDER BY m.created_at`,
      [orgId],
    );
    return { data: members, error: null };
  });

  app.get('/organizations/:orgId/invitations', auth, async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    await requireOrgRole(orgId, req.user!.id, 'admin');

    const invitations = await many(
      `SELECT i.id, i.email, i.role, i.expires_at, i.created_at,
              i.accepted_at, i.revoked_at, u.email AS invited_by_email
         FROM organization_invitations i
         JOIN users u ON u.id = i.invited_by
        WHERE i.organization_id = $1
        ORDER BY i.created_at DESC LIMIT 100`,
      [orgId],
    );
    return { data: invitations, error: null };
  });

  app.post('/organizations/:orgId/invitations', auth, async (req, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    const body = z.object({
      email: z.string().email().max(255),
      role: z.enum(ROLES).default('developer'),
    }).parse(req.body);

    const callerRole = await requireOrgRole(orgId, req.user!.id, 'admin');

    // Nobody may invite someone above their own level. Without this, an admin
    // can mint an owner and then be removed by them — privilege escalation by
    // way of a helpful invite form.
    if ((ROLE_RANK[body.role] ?? 0) > (ROLE_RANK[callerRole] ?? 0)) {
      throw new ApiError('FORBIDDEN', `You cannot invite someone as ${body.role} — that is above your own role`);
    }

    const alreadyMember = await one(
      `SELECT 1 FROM organization_members m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND u.email = $2`,
      [orgId, body.email],
    );
    if (alreadyMember) throw new ApiError('CONFLICT', 'That person is already a member');

    const token = randomToken(32);

    // Replace any pending invitation for this address rather than stacking a
    // second valid token. Several live tokens for one address is several ways in.
    const invitation = await transaction(async (client) => {
      await client.query(
        `UPDATE organization_invitations SET revoked_at = NOW()
          WHERE organization_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [orgId, body.email],
      );
      const created = await client.query<{ id: string; expires_at: string }>(
        `INSERT INTO organization_invitations (organization_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1,$2,$3,$4,$5, NOW() + ($6 || ' days')::interval)
         RETURNING id, expires_at`,
        [orgId, body.email, body.role, sha256(token), req.user!.id, String(INVITE_TTL_DAYS)],
      );
      return created.rows[0]!;
    });

    const organization = await one<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [orgId]);
    const link = `${env.FRONTEND_URL}/invite/${token}`;

    void sendMail({
      to: body.email,
      subject: `You have been invited to ${organization?.name ?? 'an organization'} on Kairos`,
      text:
        `${req.user!.email} invited you to join ${organization?.name ?? 'their organization'} as ${body.role}.\n\n` +
        `${link}\n\nThis link expires in ${INVITE_TTL_DAYS} days and can be used once.`,
    });

    void audit(req, {
      action: 'INVITATION_SENT',
      organizationId: orgId,
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadata: { email: body.email, role: body.role },
    });

    return reply.code(201).send({
      data: {
        id: invitation.id,
        email: body.email,
        role: body.role,
        expiresAt: invitation.expires_at,
        // Returned so an operator without SMTP can still pass it along. The
        // token is not recoverable afterwards — only its hash is stored.
        link: env.SMTP_HOST ? undefined : link,
      },
      error: null,
    });
  });

  app.delete('/organizations/:orgId/invitations/:id', auth, async (req) => {
    const params = z.object({ orgId: z.string().uuid(), id: z.string().uuid() }).parse(req.params);
    await requireOrgRole(params.orgId, req.user!.id, 'admin');

    const revoked = await one(
      `UPDATE organization_invitations SET revoked_at = NOW()
        WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
        RETURNING id`,
      [params.id, params.orgId],
    );
    if (!revoked) throw new ApiError('NOT_FOUND', 'No pending invitation with that id');

    void audit(req, { action: 'INVITATION_REVOKED', organizationId: params.orgId, resourceType: 'invitation', resourceId: params.id });
    return { data: { revoked: true }, error: null };
  });

  /**
   * Look at an invitation before signing in, so the login page can say what
   * the person is being invited to. Returns nothing sensitive — the
   * organization name and the role, which they are about to be told anyway.
   */
  app.get('/invitations/:token', async (req) => {
    const { token } = z.object({ token: z.string().min(16).max(200) }).parse(req.params);
    const invitation = await one<{ email: string; role: string; org_name: string; expires_at: string }>(
      `SELECT i.email, i.role, o.name AS org_name, i.expires_at
         FROM organization_invitations i
         JOIN organizations o ON o.id = i.organization_id
        WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()`,
      [sha256(token)],
    );
    if (!invitation) throw new ApiError('NOT_FOUND', 'This invitation has expired or was already used');

    return {
      data: {
        organizationName: invitation.org_name,
        role: invitation.role,
        email: invitation.email,
        expiresAt: invitation.expires_at,
      },
      error: null,
    };
  });

  app.post('/invitations/:token/accept', auth, async (req) => {
    const { token } = z.object({ token: z.string().min(16).max(200) }).parse(req.params);

    const result = await transaction(async (client) => {
      const invitation = await client.query<{ id: string; organization_id: string; email: string; role: (typeof ROLES)[number] }>(
        `SELECT id, organization_id, email, role FROM organization_invitations
          WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
          FOR UPDATE`,
        [sha256(token)],
      );
      const row = invitation.rows[0];
      if (!row) throw new ApiError('NOT_FOUND', 'This invitation has expired or was already used');

      // The invitation is for an address, not for a link-holder. A forwarded
      // email must not become a membership.
      if (row.email.toLowerCase() !== req.user!.email.toLowerCase()) {
        throw new ApiError(
          'FORBIDDEN',
          `This invitation was sent to ${row.email}. Sign in as that account to accept it.`,
        );
      }

      await client.query(
        `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [row.organization_id, req.user!.id, row.role],
      );
      await client.query(
        'UPDATE organization_invitations SET accepted_at = NOW(), accepted_by = $2 WHERE id = $1',
        [row.id, req.user!.id],
      );
      return row;
    });

    void audit(req, {
      action: 'INVITATION_ACCEPTED',
      organizationId: result.organization_id,
      resourceType: 'invitation',
      resourceId: result.id,
    });

    return { data: { organizationId: result.organization_id, role: result.role }, error: null };
  });

  app.patch('/organizations/:orgId/members/:userId', auth, async (req) => {
    const params = z.object({ orgId: z.string().uuid(), userId: z.string().uuid() }).parse(req.params);
    const body = z.object({ role: z.enum(ROLES) }).parse(req.body);

    const callerRole = await requireOrgRole(params.orgId, req.user!.id, 'admin');
    if ((ROLE_RANK[body.role] ?? 0) > (ROLE_RANK[callerRole] ?? 0)) {
      throw new ApiError('FORBIDDEN', 'You cannot grant a role above your own');
    }

    // Losing the last owner leaves an organization nobody can administer, and
    // there is no support desk here to fix it.
    if (body.role !== 'owner') {
      const owners = await one<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM organization_members
          WHERE organization_id = $1 AND role = 'owner' AND user_id <> $2`,
        [params.orgId, params.userId],
      );
      if (Number(owners?.count ?? 0) === 0) {
        throw new ApiError('VALIDATION_ERROR', 'An organization must keep at least one owner');
      }
    }

    const updated = await one(
      'UPDATE organization_members SET role = $3 WHERE organization_id = $1 AND user_id = $2 RETURNING role',
      [params.orgId, params.userId, body.role],
    );
    if (!updated) throw new ApiError('NOT_FOUND', 'That person is not a member');

    void audit(req, {
      action: 'MEMBER_ROLE_CHANGED',
      organizationId: params.orgId,
      resourceType: 'user',
      resourceId: params.userId,
      metadata: { role: body.role },
    });
    return { data: updated, error: null };
  });

  app.delete('/organizations/:orgId/members/:userId', auth, async (req) => {
    const params = z.object({ orgId: z.string().uuid(), userId: z.string().uuid() }).parse(req.params);

    // Leaving is always allowed; removing someone else needs admin.
    if (params.userId !== req.user!.id) await requireOrgRole(params.orgId, req.user!.id, 'admin');
    else await requireOrgRole(params.orgId, req.user!.id, 'viewer');

    const owners = await one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM organization_members
        WHERE organization_id = $1 AND role = 'owner' AND user_id <> $2`,
      [params.orgId, params.userId],
    );
    if (Number(owners?.count ?? 0) === 0) {
      throw new ApiError('VALIDATION_ERROR', 'An organization must keep at least one owner');
    }

    await query('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2', [
      params.orgId,
      params.userId,
    ]);
    void audit(req, { action: 'MEMBER_REMOVED', organizationId: params.orgId, resourceType: 'user', resourceId: params.userId });
    return { data: { removed: true }, error: null };
  });
}
