import Redis from 'ioredis';
import { env } from '../env.js';
import { logger } from '../logger.js';

const options = { maxRetriesPerRequest: null as null, enableReadyCheck: true };

export const redis = new Redis(env.REDIS_URL, options);
/** Subscriber connections cannot issue regular commands, so realtime gets its own. */
export const redisSubscriber = new Redis(env.REDIS_URL, options);
export const redisPublisher = new Redis(env.REDIS_URL, options);

for (const [name, client] of Object.entries({ redis, redisSubscriber, redisPublisher })) {
  client.on('error', (err: Error) => logger.error({ err, client: name }, 'Redis error'));
}
