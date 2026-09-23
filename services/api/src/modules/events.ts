import { Queue } from 'bullmq';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { redisPublisher } from '../lib/redis.js';

const connection = { url: env.REDIS_URL };

/** Queues shared by the API (producer) and the worker process (consumer). */
export const webhookQueue = new Queue('webhooks', { connection });
export const backupQueue = new Queue('backups', { connection });
export const emailQueue = new Queue('email', { connection });

export type PlatformEvent =
  | 'database.insert' | 'database.update' | 'database.delete'
  | 'storage.upload'  | 'storage.delete'
  | 'user.created'    | 'user.deleted';

/**
 * One call fans an event out to both consumers: Redis pub/sub for connected
 * realtime sockets, and the webhook queue for outbound HTTP delivery.
 */
export async function publishEvent(
  projectId: string,
  event: PlatformEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await redisPublisher.publish(
      `realtime:${projectId}`,
      JSON.stringify({ event, payload, at: new Date().toISOString() }),
    );
    await webhookQueue.add(
      'deliver',
      { projectId, event, payload },
      { attempts: 6, backoff: { type: 'exponential', delay: 2_000 }, removeOnComplete: 500, removeOnFail: 1000 },
    );
  } catch (err) {
    logger.error({ err, event, projectId }, 'Failed to publish event');
  }
}
