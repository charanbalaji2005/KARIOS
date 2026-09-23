/**
 * MFA routes.
 *
 * Enrolment is two steps on purpose. `POST /mfa/enroll` creates the secret and
 * returns the QR; MFA is not enforced until `POST /mfa/confirm` proves the user
 * can actually generate a code. Skipping that step is how people lock
 * themselves out by scanning a QR into an app they then delete.
 *
 * The login flow gains a middle state: correct password, MFA required, no
 * session yet. That intermediate token is deliberately narrow — it authorises
 * exactly one thing, completing the challenge, and nothing else.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { one, query, transaction } from '../db/platform.js';
import { encrypt, decrypt, sha256, verifyPassword } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { consume, RULES } from '../lib/rate-limit.js';
import { securityEvent } from '../lib/security-log.js';
import { redis } from '../lib/redis.js';
import {
  generateBackupCodes,
  generateSecret,
  normaliseBackupCode,
  provisioningUri,
  verifyTotp,
} from '../lib/totp.js';

/** Lifetime of the half-authenticated state between password and code. */
const CHALLENGE_TTL_SECONDS = 300;

export interface MfaChallenge {
  userId: string;
  email: string;
}

/**
 * Create the intermediate token issued after a correct password when MFA is on.
 *
 * Stored in Redis rather than signed as a JWT so that it can be *revoked* the
 * moment it is used. A signed token valid for five minutes is replayable for
 * five minutes; this one is gone after one use.
 */
export async function beginMfaChallenge(userId: string, email: string): Promise<string> {
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  await redis.setex(`mfa:challenge:${sha256(token)}`, CHALLENGE_TTL_SECONDS, JSON.stringify({ userId, email }));
  return token;
}

export async function consumeMfaChallenge(token: string): Promise<MfaChallenge | null> {
  const key = `mfa:challenge:${sha256(token)}`;
  const raw = await redis.get(key).catch(() => null);
  if (!raw) return null;
  await redis.del(key).catch(() => undefined);
  try {
    return JSON.parse(raw) as MfaChallenge;
  } catch {
    return null;
  }
}

/** Does this user have confirmed MFA? Used by the login route. */
export async function mfaRequired(userId: string): Promise<boolean> {
  const row = await one<{ confirmed_at: string | null }>(
    'SELECT confirmed_at FROM user_mfa WHERE user_id = $1',
    [userId],
  );
  return Boolean(row?.confirmed_at);
}

/**
 * Verify a code or a backup code for a user. Returns true on success and
 * records the step so the same code cannot be replayed.
 */
export async function verifyMfaCode(userId: string, code: string): Promise<boolean> {
  const row = await one<{ secret_enc: string; last_step: string | null }>(
    'SELECT secret_enc, last_step::text FROM user_mfa WHERE user_id = $1 AND confirmed_at IS NOT NULL',
    [userId],
  );
  if (!row) return false;

  const result = verifyTotp(decrypt(row.secret_enc), code, row.last_step === null ? null : Number(row.last_step));
  if (result.valid && result.step !== undefined) {
    await query('UPDATE user_mfa SET last_step = $2, last_used_at = NOW() WHERE user_id = $1', [userId, result.step]);
    return true;
  }

  // Fall back to a backup code. Hashed, so this is a lookup by hash rather
  // than a scan-and-compare.
  const normalised = normaliseBackupCode(code);
  if (normalised.length !== 8) return false;

  const used = await one<{ id: string }>(
    `UPDATE mfa_backup_codes SET used_at = NOW()
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
      RETURNING id`,
    [userId, sha256(normalised)],
  );
  return Boolean(used);
}

export default async function mfaRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.requireUser] };

  app.get('/auth/mfa', auth, async (req) => {
    const row = await one<{ confirmed_at: string | null; last_used_at: string | null }>(
      'SELECT confirmed_at, last_used_at FROM user_mfa WHERE user_id = $1',
      [req.user!.id],
    );
    const remaining = await one<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM mfa_backup_codes WHERE user_id = $1 AND used_at IS NULL',
      [req.user!.id],
    );
    return {
      data: {
        enabled: Boolean(row?.confirmed_at),
        pending: Boolean(row) && !row?.confirmed_at,
        lastUsedAt: row?.last_used_at ?? null,
        backupCodesRemaining: Number(remaining?.count ?? 0),
      },
      error: null,
    };
  });

  /**
   * Step 1: create a secret and return the QR. MFA is NOT active yet.
   *
   * Re-enrolling replaces any unconfirmed secret, so a user who abandoned
   * setup halfway can simply start again rather than being stuck.
   */
  app.post('/auth/mfa/enroll', auth, async (req) => {
    const existing = await one<{ confirmed_at: string | null }>(
      'SELECT confirmed_at FROM user_mfa WHERE user_id = $1',
      [req.user!.id],
    );
    if (existing?.confirmed_at) {
      throw new ApiError('CONFLICT', 'MFA is already set up. Disable it first if you want to re-enrol a new device.');
    }

    const secret = generateSecret();
    await query(
      `INSERT INTO user_mfa (user_id, secret_enc) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, confirmed_at = NULL, last_step = NULL`,
      [req.user!.id, encrypt(secret)],
    );

    return {
      data: {
        secret,
        uri: provisioningUri(secret, req.user!.email),
        // The client renders the QR. Sending an image from here would mean
        // shipping a QR encoder and a PNG down a JSON API for no benefit.
        next: 'Scan this in your authenticator app, then confirm with a code to switch MFA on.',
      },
      error: null,
    };
  });

  /** Step 2: prove the app works, then MFA becomes real and codes are issued. */
  app.post('/auth/mfa/confirm', auth, async (req) => {
    await consume('mfa', req.user!.id, RULES.login);
    const body = z.object({ code: z.string().min(6).max(12) }).parse(req.body);

    const row = await one<{ secret_enc: string }>(
      'SELECT secret_enc FROM user_mfa WHERE user_id = $1 AND confirmed_at IS NULL',
      [req.user!.id],
    );
    if (!row) throw new ApiError('NOT_FOUND', 'Start enrolment first');

    const result = verifyTotp(decrypt(row.secret_enc), body.code);
    if (!result.valid) {
      securityEvent('AUTH_FAILURE', { ip: req.ip, userId: req.user!.id, detail: 'mfa enrolment' });
      throw new ApiError('INVALID_CREDENTIALS', 'That code is not right. Check your device clock is accurate.');
    }

    const codes = generateBackupCodes();
    await transaction(async (client) => {
      await client.query('UPDATE user_mfa SET confirmed_at = NOW(), last_step = $2 WHERE user_id = $1', [
        req.user!.id,
        result.step ?? null,
      ]);
      await client.query('DELETE FROM mfa_backup_codes WHERE user_id = $1', [req.user!.id]);
      for (const code of codes) {
        await client.query('INSERT INTO mfa_backup_codes (user_id, code_hash) VALUES ($1,$2)', [
          req.user!.id,
          sha256(normaliseBackupCode(code)),
        ]);
      }
    });

    void audit(req, { action: 'MFA_ENABLED', resourceType: 'user', resourceId: req.user!.id });

    return {
      data: {
        enabled: true,
        backupCodes: codes,
        // Said plainly because people close this screen and assume they can
        // find the codes later. They cannot — only hashes are kept.
        warning: 'Save these now. They are shown once and cannot be recovered. Each works a single time.',
      },
      error: null,
    };
  });

  /**
   * Disabling MFA requires the password, not just a session.
   *
   * A stolen session token should not be enough to remove the control that
   * exists to make stolen session tokens less useful.
   */
  app.post('/auth/mfa/disable', auth, async (req) => {
    const body = z.object({ password: z.string().min(1) }).parse(req.body);
    const user = await one<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [
      req.user!.id,
    ]);
    if (!user?.password_hash || !(await verifyPassword(user.password_hash, body.password))) {
      securityEvent('AUTH_FAILURE', { ip: req.ip, userId: req.user!.id, detail: 'mfa disable' });
      throw new ApiError('INVALID_CREDENTIALS', 'That password is not right');
    }

    await query('DELETE FROM user_mfa WHERE user_id = $1', [req.user!.id]);
    await query('DELETE FROM mfa_backup_codes WHERE user_id = $1', [req.user!.id]);
    void audit(req, { action: 'MFA_DISABLED', resourceType: 'user', resourceId: req.user!.id });

    return { data: { enabled: false }, error: null };
  });

  /** Regenerate backup codes. Invalidates every previous code. */
  app.post('/auth/mfa/backup-codes', auth, async (req) => {
    const body = z.object({ code: z.string().min(6).max(12) }).parse(req.body);
    if (!(await verifyMfaCode(req.user!.id, body.code))) {
      throw new ApiError('INVALID_CREDENTIALS', 'That code is not right');
    }

    const codes = generateBackupCodes();
    await transaction(async (client) => {
      await client.query('DELETE FROM mfa_backup_codes WHERE user_id = $1', [req.user!.id]);
      for (const code of codes) {
        await client.query('INSERT INTO mfa_backup_codes (user_id, code_hash) VALUES ($1,$2)', [
          req.user!.id,
          sha256(normaliseBackupCode(code)),
        ]);
      }
    });

    void audit(req, { action: 'MFA_BACKUP_CODES_REGENERATED', resourceType: 'user', resourceId: req.user!.id });
    return { data: { backupCodes: codes, warning: 'Your previous codes no longer work.' }, error: null };
  });
}
