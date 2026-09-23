import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../env.js';
import { many, one, query, transaction } from '../db/platform.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.js';
import { securityEvent } from '../lib/security-log.js';
import { beginMfaChallenge, consumeMfaChallenge, mfaRequired, verifyMfaCode } from './mfa.routes.js';
import { ApiError } from '../lib/errors.js';
import { signAccessToken } from '../lib/jwt.js';
import { consume, RULES } from '../lib/rate-limit.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';

const credentials = z.object({
  email: z.string().email().max(255),
  password: z.string().min(10, 'Use at least 10 characters').max(200),
});

const signupBody = credentials.extend({ fullName: z.string().min(1).max(120).optional() });

const REFRESH_COOKIE = 'kairos_refresh';

function refreshExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** Issues a fresh access token plus a rotated refresh token bound to a session row. */
export async function issueSession(
  userId: string,
  email: string,
  meta: { ip?: string; userAgent?: string },
): Promise<{ accessToken: string; refreshToken: string; sessionId: string }> {
  const refreshToken = randomToken(48);
  const session = await one<{ id: string }>(
    `INSERT INTO sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, sha256(refreshToken), meta.userAgent ?? null, meta.ip ?? null, refreshExpiry()],
  );
  return {
    accessToken: await signAccessToken(userId, email),
    refreshToken,
    sessionId: session!.id,
  };
}

export default async function authRoutes(app: FastifyInstance) {
  app.post('/auth/signup', async (req, reply) => {
    await consume('signup', req.ip, RULES.signup);
    const body = signupBody.parse(req.body);

    const existing = await one('SELECT id FROM users WHERE email = $1', [body.email]);
    if (existing) throw new ApiError('CONFLICT', 'An account with this email already exists');

    const result = await transaction(async (client) => {
      const user = await client.query<{ id: string; email: string }>(
        `INSERT INTO users (email, password_hash, full_name)
         VALUES ($1, $2, $3) RETURNING id, email`,
        [body.email, await hashPassword(body.password), body.fullName ?? null],
      );
      const created = user.rows[0]!;

      // Every new account gets a personal organization so projects have a home.
      const slugBase = body.email.split('@')[0]!.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      const org = await client.query<{ id: string }>(
        `INSERT INTO organizations (name, slug, created_by)
         VALUES ($1, $2, $3) RETURNING id`,
        [`${body.fullName ?? slugBase}'s org`, `${slugBase}-${randomToken(4).toLowerCase().slice(0, 6)}`, created.id],
      );
      await client.query(
        `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [org.rows[0]!.id, created.id],
      );
      return { user: created, organizationId: org.rows[0]!.id };
    });

    const verifyToken = randomToken();
    await query(
      `INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at)
       VALUES ($1, 'verify_email', $2, NOW() + INTERVAL '24 hours')`,
      [result.user.id, sha256(verifyToken)],
    );
    void sendMail({
      to: body.email,
      subject: 'Confirm your KairosDB email',
      text: `Confirm your email: ${env.FRONTEND_URL}/verify?token=${verifyToken}`,
    });

    const session = await issueSession(result.user.id, result.user.email, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    void audit(req, { actorId: result.user.id, action: 'USER_CREATED', resourceType: 'user', resourceId: result.user.id });

    reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', path: '/', maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400,
    });
    return reply.code(201).send({
      data: {
        user: { id: result.user.id, email: result.user.email },
        organizationId: result.organizationId,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      },
      error: null,
    });
  });

  app.post('/auth/login', async (req, reply) => {
    await consume('login', req.ip, RULES.login);
    const body = credentials.parse(req.body);

    const user = await one<{ id: string; email: string; password_hash: string }>(
      'SELECT id, email, password_hash FROM users WHERE email = $1 AND deleted_at IS NULL',
      [body.email],
    );
    // Same error and roughly the same work either way — do not leak which emails exist.
    const ok = user ? await verifyPassword(user.password_hash, body.password) : await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000', body.password);
    if (!user || !ok) {
      // Fail2ban reads this. The email is deliberately not logged — a bad
      // password on someone else's account should not write their address
      // into a file that a dozen processes can read.
      securityEvent('AUTH_FAILURE', {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        detail: 'login',
      });
      throw new ApiError('INVALID_CREDENTIALS', 'Email or password is incorrect');
    }

    // Correct password, but not yet a session: if MFA is on, the caller gets a
    // narrow challenge token that authorises exactly one thing — completing the
    // challenge — and nothing else.
    if (await mfaRequired(user.id)) {
      const challenge = await beginMfaChallenge(user.id, user.email);
      return reply.code(200).send({
        data: { mfaRequired: true, challengeToken: challenge, expiresInSeconds: 300 },
        error: null,
      });
    }

    const session = await issueSession(user.id, user.email, { ip: req.ip, userAgent: req.headers['user-agent'] });
    void audit(req, { actorId: user.id, action: 'USER_LOGIN', resourceType: 'user', resourceId: user.id });

    reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', path: '/', maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400,
    });
    return {
      data: {
        user: { id: user.id, email: user.email },
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      },
      error: null,
    };
  });

  /**
   * Refresh rotation: the presented token is consumed and replaced. Reuse of an
   * already-rotated token revokes the whole family, which is the standard
   * response to a stolen refresh token.
   */
  app.post('/auth/refresh', async (req, reply) => {
    const presented =
      (req.body as { refreshToken?: string } | undefined)?.refreshToken ??
      (req.cookies?.[REFRESH_COOKIE] as string | undefined);
    if (!presented) throw new ApiError('AUTH_REQUIRED', 'No refresh token provided');

    const hash = sha256(presented);
    const session = await one<{ id: string; user_id: string; email: string; revoked_at: string | null; expires_at: string }>(
      `SELECT s.id, s.user_id, s.revoked_at, s.expires_at, u.email
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.refresh_token_hash = $1`,
      [hash],
    );
    if (!session) throw new ApiError('INVALID_TOKEN', 'Invalid refresh token');

    if (session.revoked_at) {
      await query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [session.user_id]);
      void audit(req, { actorId: session.user_id, action: 'REFRESH_TOKEN_REUSE_DETECTED' });
      // A replayed refresh token means either a stolen token or a badly
      // written client. Either way the IP is worth a ban after a few tries.
      securityEvent('TOKEN_REUSE', {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        userId: session.user_id,
        detail: 'refresh token replayed after rotation',
      });
      throw new ApiError('INVALID_TOKEN', 'This session was revoked. Sign in again.');
    }
    if (new Date(session.expires_at) < new Date()) {
      throw new ApiError('INVALID_TOKEN', 'This session has expired. Sign in again.');
    }

    await query('UPDATE sessions SET revoked_at = NOW() WHERE id = $1', [session.id]);
    const next = await issueSession(session.user_id, session.email, { ip: req.ip, userAgent: req.headers['user-agent'] });

    reply.setCookie(REFRESH_COOKIE, next.refreshToken, {
      httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', path: '/', maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400,
    });
    return { data: { accessToken: next.accessToken, refreshToken: next.refreshToken }, error: null };
  });

  app.post('/auth/logout', async (req, reply) => {
    const presented =
      (req.body as { refreshToken?: string } | undefined)?.refreshToken ??
      (req.cookies?.[REFRESH_COOKIE] as string | undefined);
    if (presented) {
      await query('UPDATE sessions SET revoked_at = NOW() WHERE refresh_token_hash = $1', [sha256(presented)]);
    }
    reply.clearCookie(REFRESH_COOKIE, { path: '/' });
    return { data: { signedOut: true }, error: null };
  });

  app.get('/auth/me', { preHandler: [app.requireUser] }, async (req) => {
    const user = await one(
      'SELECT id, email, full_name, email_verified, is_platform_admin, created_at FROM users WHERE id = $1',
      [req.user!.id],
    );
    const orgs = await many(
      `SELECT o.id, o.name, o.slug, om.role
         FROM organizations o
         JOIN organization_members om ON om.organization_id = o.id
        WHERE om.user_id = $1 AND o.deleted_at IS NULL
        ORDER BY o.created_at`,
      [req.user!.id],
    );
    return { data: { user, organizations: orgs }, error: null };
  });

  app.get('/auth/sessions', { preHandler: [app.requireUser] }, async (req) => {
    const sessions = await many(
      `SELECT id, user_agent, ip_address, created_at, expires_at, revoked_at
         FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user!.id],
    );
    return { data: sessions, error: null };
  });

  app.delete('/auth/sessions/:id', { preHandler: [app.requireUser] }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await query('UPDATE sessions SET revoked_at = NOW() WHERE id = $1 AND user_id = $2', [id, req.user!.id]);
    return { data: { revoked: true }, error: null };
  });

  /**
   * Complete an MFA challenge.
   *
   * The challenge token is consumed on first use whether or not the code is
   * right, so a captured token cannot be brute-forced. A wrong code means
   * starting again from the password, which is the correct amount of friction
   * for someone who is either fat-fingering or attacking.
   */
  app.post('/auth/mfa/challenge', async (req, reply) => {
    await consume('mfa-challenge', req.ip, RULES.login);
    const body = z.object({ challengeToken: z.string().min(16), code: z.string().min(6).max(12) }).parse(req.body);

    const challenge = await consumeMfaChallenge(body.challengeToken);
    if (!challenge) {
      securityEvent('AUTH_FAILURE', { ip: req.ip, detail: 'mfa challenge expired or reused' });
      throw new ApiError('INVALID_TOKEN', 'That sign-in attempt expired. Start again.');
    }

    if (!(await verifyMfaCode(challenge.userId, body.code))) {
      securityEvent('AUTH_FAILURE', { ip: req.ip, userId: challenge.userId, detail: 'mfa code' });
      throw new ApiError('INVALID_CREDENTIALS', 'That code is not right');
    }

    const session = await issueSession(challenge.userId, challenge.email, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    void audit(req, { actorId: challenge.userId, action: 'USER_LOGIN_MFA', resourceType: 'user', resourceId: challenge.userId });

    reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', path: '/', maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400,
    });
    return {
      data: {
        user: { id: challenge.userId, email: challenge.email },
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      },
      error: null,
    };
  });

  app.post('/auth/password/forgot', async (req) => {
    await consume('password-reset', req.ip, RULES.passwordReset);
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const user = await one<{ id: string }>('SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);

    if (user) {
      const token = randomToken();
      await query(
        `INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at)
         VALUES ($1, 'reset_password', $2, NOW() + INTERVAL '1 hour')`,
        [user.id, sha256(token)],
      );
      void sendMail({
        to: email,
        subject: 'Reset your KairosDB password',
        text: `Reset your password: ${env.FRONTEND_URL}/reset-password?token=${token}`,
      });
    }
    // Always the same response, whether or not the account exists.
    return { data: { sent: true }, error: null };
  });

  app.post('/auth/password/reset', async (req) => {
    const body = z.object({ token: z.string().min(10), password: z.string().min(10).max(200) }).parse(req.body);
    const row = await one<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM email_tokens
        WHERE token_hash = $1 AND purpose = 'reset_password'
          AND consumed_at IS NULL AND expires_at > NOW()`,
      [sha256(body.token)],
    );
    if (!row) throw new ApiError('INVALID_TOKEN', 'This reset link is invalid or has expired');

    await transaction(async (client) => {
      await client.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [
        await hashPassword(body.password),
        row.user_id,
      ]);
      await client.query('UPDATE email_tokens SET consumed_at = NOW() WHERE id = $1', [row.id]);
      // Changing a password kills every existing session.
      await client.query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [row.user_id]);
    });

    void audit(req, { actorId: row.user_id, action: 'PASSWORD_RESET' });
    return { data: { reset: true }, error: null };
  });

  app.post('/auth/verify-email', async (req) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    const row = await one<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM email_tokens
        WHERE token_hash = $1 AND purpose = 'verify_email' AND consumed_at IS NULL AND expires_at > NOW()`,
      [sha256(token)],
    );
    if (!row) throw new ApiError('INVALID_TOKEN', 'This verification link is invalid or has expired');

    await transaction(async (client) => {
      await client.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [row.user_id]);
      await client.query('UPDATE email_tokens SET consumed_at = NOW() WHERE id = $1', [row.id]);
    });
    return { data: { verified: true }, error: null };
  });
}

/** Alias for callers outside this module (the OAuth exchange). */
export { issueSession as issueSessionFor };
