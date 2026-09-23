/**
 * Request authentication between the API and the agent.
 *
 * The socket's filesystem permissions are the first control — only members of
 * the `kairos` group can connect at all. This is the second, and it exists
 * because the first one is a single `chmod` away from being wrong, and because
 * the optional loopback fallback has no filesystem permissions to rely on.
 *
 * Every request carries an HMAC-SHA256 over `timestamp.nonce.method.path.body`.
 * Signing the method and path as well as the body means a captured
 * `GET /agent/system` cannot be replayed as `POST /agent/server/reboot`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

export interface SignatureInput {
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  body: string;
}

export function sign(input: SignatureInput, token: string = config.token): string {
  return createHmac('sha256', token)
    .update([input.timestamp, input.nonce, input.method.toUpperCase(), input.path, input.body].join('\n'))
    .digest('hex');
}

/**
 * Nonces already seen, so a signature that is still inside the clock-skew
 * window cannot be used twice. Bounded by the skew window rather than by a
 * count: entries older than the window can never be accepted again anyway.
 */
const seenNonces = new Map<string, number>();

function pruneNonces(now: number): void {
  if (seenNonces.size < 512) return;
  for (const [nonce, at] of seenNonces) {
    if (now - at > config.maxClockSkewMs * 2) seenNonces.delete(nonce);
  }
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verify(
  headers: Record<string, string | string[] | undefined>,
  method: string,
  path: string,
  body: string,
): VerifyResult {
  const header = (name: string): string | null => {
    const value = headers[name];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  };

  const timestamp = header('x-kairos-timestamp');
  const nonce = header('x-kairos-nonce');
  const signature = header('x-kairos-signature');

  if (!timestamp || !nonce || !signature) return { ok: false, reason: 'missing signature headers' };
  if (nonce.length < 16 || nonce.length > 128) return { ok: false, reason: 'malformed nonce' };

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: 'malformed timestamp' };

  const now = Date.now();
  if (Math.abs(now - sentAt) > config.maxClockSkewMs) {
    return { ok: false, reason: 'timestamp outside the accepted window' };
  }

  if (seenNonces.has(nonce)) return { ok: false, reason: 'nonce replayed' };

  const expected = sign({ timestamp, nonce, method, path, body });

  // Length check first: timingSafeEqual throws on a length mismatch, and
  // throwing is itself an observable difference in behaviour.
  if (signature.length !== expected.length) return { ok: false, reason: 'signature mismatch' };
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' };

  pruneNonces(now);
  seenNonces.set(nonce, now);
  return { ok: true };
}
