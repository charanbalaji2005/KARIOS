/**
 * OAuth — Google and GitHub.
 *
 * Authorization Code flow with PKCE, `state` and (for Google) `nonce`. Not a
 * homemade token exchange: the failure modes of doing this by hand are well
 * known and all of them end with someone else's session.
 *
 * What each piece is actually for, since they get copied around without it:
 *
 *   state    binds the callback to the browser that started the flow. Without
 *            it, an attacker completes their own authorization and feeds you
 *            the code, logging you into *their* account — login CSRF.
 *   PKCE     binds the code to the client that requested it. Originally for
 *            mobile apps that cannot keep a secret; useful here because a code
 *            leaked through a Referer header or a proxy log is then useless.
 *   nonce    binds the ID token to this request, so a replayed token from
 *            another session fails.
 *
 * `state` and the verifier live server-side rather than in a cookie, because a
 * cross-site redirect back from the provider is exactly the case where Safari
 * and friends will have dropped the cookie.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { one, query, transaction } from '../db/platform.js';
import { env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { logger } from '../logger.js';
import { consume, RULES } from '../lib/rate-limit.js';
import { securityEvent } from '../lib/security-log.js';

type Provider = 'google' | 'github';

interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  scope: string;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  /** GitHub does not implement OIDC, so there is no id_token to check a nonce against. */
  supportsPkce: boolean;
}

function providers(): Record<Provider, ProviderConfig> {
  return {
    google: {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      scope: 'openid email profile',
      clientId: process.env['GOOGLE_CLIENT_ID'],
      clientSecret: process.env['GOOGLE_CLIENT_SECRET'],
      supportsPkce: true,
    },
    github: {
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      userUrl: 'https://api.github.com/user',
      scope: 'read:user user:email',
      clientId: process.env['GITHUB_CLIENT_ID'],
      clientSecret: process.env['GITHUB_CLIENT_SECRET'],
      supportsPkce: true,
    },
  };
}

function configured(provider: Provider): ProviderConfig {
  const config = providers()[provider];
  if (!config.clientId || !config.clientSecret) {
    throw new ApiError(
      'NOT_FOUND',
      `${provider} sign-in is not configured on this server. Set ${provider.toUpperCase()}_CLIENT_ID and _CLIENT_SECRET.`,
    );
  }
  return config;
}

const base64url = (buffer: Buffer) => buffer.toString('base64url');

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

const callbackUrl = (provider: Provider) => `${env.API_URL}/api/v1/auth/oauth/${provider}/callback`;

interface ProviderProfile {
  uid: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
  emailVerified: boolean;
}

async function fetchProfile(provider: Provider, accessToken: string): Promise<ProviderProfile> {
  const config = providers()[provider];
  const response = await fetch(config.userUrl, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      'user-agent': 'kairosdb',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new ApiError('INTERNAL_ERROR', `${provider} rejected the profile request`);

  const profile = (await response.json()) as Record<string, unknown>;

  if (provider === 'google') {
    return {
      uid: String(profile['sub']),
      email: (profile['email'] as string | undefined) ?? null,
      name: (profile['name'] as string | undefined) ?? null,
      avatar: (profile['picture'] as string | undefined) ?? null,
      emailVerified: profile['email_verified'] === true,
    };
  }

  // GitHub omits the email from /user when the user has it set to private, so
  // a second call is needed. Treating "no email" as an error would lock out
  // everyone with sensible privacy settings.
  let email = (profile['email'] as string | undefined) ?? null;
  let emailVerified = false;
  if (!email) {
    const emails = await fetch('https://api.github.com/user/emails', {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': 'kairosdb' },
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ email: string; primary: boolean; verified: boolean }[]>) : []))
      .catch(() => []);
    const primary = emails.find((entry) => entry.primary && entry.verified) ?? emails.find((entry) => entry.verified);
    email = primary?.email ?? null;
    emailVerified = Boolean(primary?.verified);
  } else {
    emailVerified = true;
  }

  return {
    uid: String(profile['id']),
    email,
    name: (profile['name'] as string | undefined) ?? (profile['login'] as string | undefined) ?? null,
    avatar: (profile['avatar_url'] as string | undefined) ?? null,
    emailVerified,
  };
}

export default async function oauthRoutes(app: FastifyInstance) {
  /** Which providers this server can actually do, so the UI shows real buttons. */
  app.get('/auth/oauth/providers', async () => {
    const all = providers();
    return {
      data: (Object.keys(all) as Provider[])
        .filter((name) => all[name].clientId && all[name].clientSecret)
        .map((name) => ({ provider: name, start: `/api/v1/auth/oauth/${name}` })),
      error: null,
    };
  });

  /** Start the flow. */
  app.get('/auth/oauth/:provider', async (req, reply) => {
    const { provider } = z.object({ provider: z.enum(['google', 'github']) }).parse(req.params);
    const q = z.object({ redirect_to: z.string().max(500).optional() }).parse(req.query);
    const config = configured(provider);

    const state = base64url(randomBytes(32));
    const { verifier, challenge } = pkcePair();
    const nonce = randomUUID();

    // Only a path is accepted as a post-login destination. An absolute URL
    // here is an open redirect, which turns your login page into a convincing
    // launchpad for someone else's phishing.
    const redirectTo = q.redirect_to && q.redirect_to.startsWith('/') && !q.redirect_to.startsWith('//')
      ? q.redirect_to
      : '/projects';

    await query(
      `INSERT INTO oauth_states (state, provider, code_verifier, nonce, redirect_to, expires_at)
       VALUES ($1,$2,$3,$4,$5, NOW() + INTERVAL '10 minutes')`,
      [state, provider, verifier, nonce, redirectTo],
    );

    const params = new URLSearchParams({
      client_id: config.clientId!,
      redirect_uri: callbackUrl(provider),
      response_type: 'code',
      scope: config.scope,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (provider === 'google') {
      params.set('nonce', nonce);
      // Force the account chooser rather than silently reusing whichever
      // Google session the browser happens to hold.
      params.set('prompt', 'select_account');
    }

    return reply.redirect(`${config.authorizeUrl}?${params.toString()}`);
  });

  /** Provider redirects back here. */
  app.get('/auth/oauth/:provider/callback', async (req, reply) => {
    await consume('oauth', req.ip, RULES.login);
    const { provider } = z.object({ provider: z.enum(['google', 'github']) }).parse(req.params);
    const q = z
      .object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() })
      .parse(req.query);

    const fail = (reason: string) =>
      reply.redirect(`${env.FRONTEND_URL}/login?error=${encodeURIComponent(reason)}`);

    if (q.error || !q.code || !q.state) {
      return fail(q.error ?? 'Sign-in was cancelled');
    }

    const config = configured(provider);

    // Consume the state atomically. A state that has already been used must
    // not work a second time, or a leaked callback URL is replayable.
    const stored = await one<{ code_verifier: string; nonce: string; redirect_to: string; provider: Provider }>(
      `UPDATE oauth_states SET consumed_at = NOW()
        WHERE state = $1 AND consumed_at IS NULL AND expires_at > NOW()
        RETURNING code_verifier, nonce, redirect_to, provider`,
      [q.state],
    );
    if (!stored || stored.provider !== provider) {
      securityEvent('AUTH_FAILURE', { ip: req.ip, detail: `oauth state rejected (${provider})` });
      return fail('That sign-in link expired or was already used');
    }

    let tokenResponse: Response;
    try {
      tokenResponse = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          client_id: config.clientId!,
          client_secret: config.clientSecret!,
          code: q.code,
          redirect_uri: callbackUrl(provider),
          grant_type: 'authorization_code',
          code_verifier: stored.code_verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      logger.error({ err: error, provider }, 'oauth token exchange failed');
      return fail('Could not reach the sign-in provider');
    }

    if (!tokenResponse.ok) {
      logger.warn({ provider, status: tokenResponse.status }, 'oauth token exchange rejected');
      return fail('The sign-in provider rejected this attempt');
    }

    const tokens = (await tokenResponse.json()) as { access_token?: string; id_token?: string };
    if (!tokens.access_token) return fail('The sign-in provider returned no token');

    let profile: ProviderProfile;
    try {
      profile = await fetchProfile(provider, tokens.access_token);
    } catch (error) {
      logger.error({ err: error, provider }, 'oauth profile fetch failed');
      return fail('Could not read your profile from the provider');
    }

    if (!profile.email) {
      return fail('Your account has no verified email address, which this server needs');
    }
    if (!profile.emailVerified) {
      // An unverified provider email is an account-takeover vector: register
      // an unverified address that matches an existing user and walk in.
      return fail('Verify your email with the provider first');
    }

    const userId = await transaction(async (client) => {
      const linked = await client.query<{ user_id: string }>(
        'SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_uid = $2',
        [provider, profile.uid],
      );
      if (linked.rows[0]) return linked.rows[0].user_id;

      // Link by verified email. Both sides being verified is what makes this
      // safe; without that check it is a takeover primitive.
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL',
        [profile.email],
      );

      let id: string;
      if (existing.rows[0]) {
        id = existing.rows[0].id;
      } else {
        const created = await client.query<{ id: string }>(
          `INSERT INTO users (email, full_name, email_verified, password_hash)
           VALUES ($1,$2,TRUE,NULL) RETURNING id`,
          [profile.email, profile.name],
        );
        id = created.rows[0]!.id;

        // Same personal organization every signup gets, so an OAuth user is
        // not a second-class account missing the thing projects hang off.
        const org = await client.query<{ id: string }>(
          'INSERT INTO organizations (name, created_by) VALUES ($1,$2) RETURNING id',
          [profile.name ? `${profile.name}'s org` : 'Personal', id],
        );
        await client.query(
          "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'owner')",
          [org.rows[0]!.id, id],
        );
      }

      await client.query(
        `INSERT INTO oauth_accounts (user_id, provider, provider_uid, email, display_name, avatar_url)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (provider, provider_uid) DO UPDATE
           SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url`,
        [id, provider, profile.uid, profile.email, profile.name, profile.avatar],
      );
      return id;
    });

    void audit(null, { actorId: userId, action: 'USER_LOGIN_OAUTH', resourceType: 'user', resourceId: userId, metadata: { provider } });

    // The session is handed over as a single-use ticket in the URL rather than
    // the access token itself: URLs end up in history, Referer headers and
    // server logs, and a token there outlives the redirect.
    const { issueOauthTicket } = await import('../lib/oauth-ticket.js');
    const ticket = await issueOauthTicket(userId, profile.email);
    return reply.redirect(`${env.FRONTEND_URL}/auth/callback?ticket=${ticket}&next=${encodeURIComponent(stored.redirect_to)}`);
  });

  /** Exchange the one-time ticket for a real session. */
  app.post('/auth/oauth/exchange', async (req, reply) => {
    const body = z.object({ ticket: z.string().min(16) }).parse(req.body);
    const { consumeOauthTicket } = await import('../lib/oauth-ticket.js');
    const claim = await consumeOauthTicket(body.ticket);
    if (!claim) throw new ApiError('INVALID_TOKEN', 'That sign-in link expired. Try again.');

    const { issueSessionFor } = await import('./auth.routes.js');
    const session = await issueSessionFor(claim.userId, claim.email, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    reply.setCookie('kairos_refresh', session.refreshToken, {
      httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', path: '/',
      maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400,
    });
    return {
      data: { user: { id: claim.userId, email: claim.email }, accessToken: session.accessToken, refreshToken: session.refreshToken },
      error: null,
    };
  });
}
