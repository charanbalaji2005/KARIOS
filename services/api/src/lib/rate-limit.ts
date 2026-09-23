import { redis } from './redis.js';
import { ApiError } from './errors.js';

export interface LimitRule {
  /** Requests allowed inside the window. */
  points: number;
  /** Window length in seconds. */
  window: number;
}

export const RULES = {
  login: { points: 10, window: 300 },
  signup: { points: 5, window: 3600 },
  passwordReset: { points: 3, window: 3600 },
  api: { points: 600, window: 60 },
  sql: { points: 60, window: 60 },
  upload: { points: 120, window: 60 },
} as const satisfies Record<string, LimitRule>;

/**
 * Fixed-window counter in Redis. Cheap, and accurate enough for abuse control;
 * swap for a sliding window if you start caring about burst edges.
 */
export async function consume(bucket: string, identifier: string, rule: LimitRule): Promise<void> {
  const key = `rl:${bucket}:${identifier}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, rule.window);
  if (count > rule.points) {
    const ttl = await redis.ttl(key);
    throw new ApiError('RATE_LIMITED', `Too many requests. Try again in ${Math.max(ttl, 1)} seconds.`, {
      retryAfter: Math.max(ttl, 1),
    });
  }
}
