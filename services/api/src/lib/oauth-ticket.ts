/**
 * One-time tickets for the OAuth redirect.
 *
 * The callback has to get a session to a browser through a URL. Putting the
 * access token there would leak it into browser history, the Referer header of
 * the next request, and any proxy log along the way — and it would stay valid
 * afterwards.
 *
 * A ticket is a random value with a 60-second life that can be redeemed once,
 * for exactly one thing. Stored in Redis so redemption genuinely removes it;
 * a signed token would remain replayable for its whole lifetime.
 */
import { randomBytes } from 'node:crypto';
import { redis } from './redis.js';
import { sha256 } from './crypto.js';

const TICKET_TTL_SECONDS = 60;

export async function issueOauthTicket(userId: string, email: string): Promise<string> {
  const ticket = randomBytes(32).toString('base64url');
  await redis.setex(`oauth:ticket:${sha256(ticket)}`, TICKET_TTL_SECONDS, JSON.stringify({ userId, email }));
  return ticket;
}

export async function consumeOauthTicket(ticket: string): Promise<{ userId: string; email: string } | null> {
  const key = `oauth:ticket:${sha256(ticket)}`;
  const raw = await redis.get(key).catch(() => null);
  if (!raw) return null;
  await redis.del(key).catch(() => undefined);
  try {
    return JSON.parse(raw) as { userId: string; email: string };
  } catch {
    return null;
  }
}
