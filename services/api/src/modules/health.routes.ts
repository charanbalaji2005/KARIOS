import type { FastifyInstance } from 'fastify';
import { platformPool } from '../db/platform.js';
import { redis } from '../lib/redis.js';
import { storage as storageDriver } from '../lib/storage/index.js';

type Status = 'healthy' | 'degraded' | 'down';

async function probe(fn: () => Promise<unknown>): Promise<Status> {
  try {
    await fn();
    return 'healthy';
  } catch {
    return 'down';
  }
}

export default async function healthRoutes(app: FastifyInstance) {
  /** Liveness: is the process up. Never touches dependencies. */
  app.get('/api/health', async () => ({ data: { status: 'healthy', uptime: process.uptime() }, error: null }));

  /** Readiness: can this instance actually serve traffic. */
  app.get('/api/ready', async (_req, reply) => {
    const [postgres, redisStatus, storage] = await Promise.all([
      probe(() => platformPool.query('SELECT 1')),
      probe(() => redis.ping()),
      // Creating the probe namespace is idempotent for both drivers and
      // proves the backing store is actually writable — a read-only check
      // passes happily on a full disk, which is the case that matters.
      probe(() => storageDriver.ensureNamespace('probe')),
    ]);

    const services = { postgres, redis: redisStatus, storage };
    const ready = postgres === 'healthy' && redisStatus === 'healthy';
    return reply.code(ready ? 200 : 503).send({
      data: { status: ready ? 'healthy' : 'degraded', services },
      error: null,
    });
  });

  app.get('/api/version', async () => ({
    data: { name: 'kairosdb-api', version: process.env.npm_package_version ?? '0.1.0', node: process.version },
    error: null,
  }));
}
