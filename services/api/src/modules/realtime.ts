import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import pg from 'pg';
import Redis from 'ioredis';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { one } from '../db/platform.js';
import { poolManager } from '../db/pool-manager.js';
import { decrypt, sha256 } from '../lib/crypto.js';
import { verifyProjectToken } from '../lib/jwt.js';
import { redisPublisher, redisSubscriber } from '../lib/redis.js';
import { authorizeEvent, identityKey, type ChangeEvent, type SubscriberIdentity } from '../lib/realtime-authz.js';

const { Client } = pg;

interface Subscription {
  socket: WebSocket;
  projectId: string;
  /** `schema.table` or `schema.*` */
  topics: Set<string>;
  bypassRls: boolean;
  userId: string | null;
  /** Verified project-token claims, used to answer "can this identity see this row?" */
  claims: Record<string, unknown> | null;
}

const subscriptions = new Set<Subscription>();
/** One dedicated LISTEN connection per project, opened on first subscriber. */
const listeners = new Map<string, pg.Client>();

/**
 * Opens a long-lived LISTEN connection on the project's database. Postgres
 * NOTIFY is the change source; Redis is the fan-out, so any API replica can
 * serve any socket.
 */
async function ensureListener(projectId: string): Promise<void> {
  if (listeners.has(projectId)) return;

  const creds = await poolManager.credentials(projectId);
  const client = new Client({ ...creds, application_name: `kairosdb-realtime-${projectId.slice(0, 8)}` });
  listeners.set(projectId, client);

  client.on('notification', (msg) => {
    if (msg.channel !== 'kairos_realtime' || !msg.payload) return;
    void redisPublisher.publish(`realtime:${projectId}`, msg.payload);
  });

  client.on('error', (err) => {
    logger.error({ err, projectId }, 'Realtime listener dropped, will reconnect on next subscribe');
    listeners.delete(projectId);
    client.end().catch(() => undefined);
  });

  await client.connect();
  await client.query('LISTEN kairos_realtime');
  logger.info({ projectId }, 'Realtime listener attached');
}

async function stopListenerIfIdle(projectId: string): Promise<void> {
  const stillUsed = [...subscriptions].some((s) => s.projectId === projectId);
  if (stillUsed) return;
  const client = listeners.get(projectId);
  if (!client) return;
  listeners.delete(projectId);
  await client.end().catch(() => undefined);
}

/**
 * Deliver one change event to the subscribers entitled to see it.
 *
 * Every row is authorized against the project's own RLS policies before it
 * leaves the process. Subscribing to a table is permission to be *told about*
 * that table, not permission to read rows the policies would refuse over REST.
 *
 * Async, so a slow authorization pass cannot block the Redis message handler
 * and stall every other project's events behind it.
 */
async function deliver(projectId: string, event: ChangeEvent & { event?: string }): Promise<void> {
  const schema = event.schema ?? 'public';
  const table = event.table ?? '*';

  const interested = [...subscriptions].filter(
    (sub) =>
      sub.projectId === projectId &&
      (sub.topics.has(`${schema}.${table}`) || sub.topics.has(`${schema}.*`)),
  );
  if (interested.length === 0) return;

  // Group by identity so that fifty sockets belonging to one user cost one
  // visibility probe rather than fifty.
  const identities = new Map<string, SubscriberIdentity>();
  for (const sub of interested) {
    const identity: SubscriberIdentity = { bypassRls: sub.bypassRls, userId: sub.userId, claims: sub.claims };
    identities.set(identityKey(identity), identity);
  }

  let allowed: Set<string>;
  try {
    allowed = await authorizeEvent(projectId, { ...event, schema, table }, identities);
  } catch (err) {
    // Fail closed. A dropped event is a bug report; a leaked row is an incident.
    logger.error({ err, projectId }, 'realtime authorization threw — dropping event');
    return;
  }

  for (const sub of interested) {
    const key = identityKey({ bypassRls: sub.bypassRls, userId: sub.userId, claims: sub.claims });
    if (!allowed.has(key)) continue;
    try {
      sub.socket.send(JSON.stringify(Object.assign({}, event, { type: 'change', schema, table })));
    } catch (err) {
      logger.debug({ err }, 'Failed to deliver realtime frame');
    }
  }
}

/** Redis side: one subscriber connection pattern-matching every project channel. */
export async function startRealtimeBridge(): Promise<void> {
  await redisSubscriber.psubscribe('realtime:*');
  redisSubscriber.on('pmessage', (_pattern, channel, message) => {
    const projectId = channel.slice('realtime:'.length);
    let parsed: ChangeEvent & { event?: string };
    try {
      parsed = JSON.parse(message) as ChangeEvent & { event?: string };
    } catch {
      return;
    }

    void deliver(projectId, parsed);
  });
  logger.info('Realtime bridge listening on realtime:*');
}

export default async function realtimeRoutes(app: FastifyInstance) {
  /**
   * Handshake: ?apikey=...&token=... . The key identifies the project, the
   * optional user token identifies the subscriber. Sockets are not allowed to
   * pick a project by id — only by a key they hold.
   */
  app.get('/realtime/v1', { websocket: true }, async (socket, req) => {
    const q = req.query as { apikey?: string; token?: string };
    const close = (code: number, reason: string) => {
      try { socket.send(JSON.stringify({ type: 'error', message: reason })); } catch { /* ignore */ }
      socket.close(code, reason);
    };

    if (!q.apikey) return close(4401, 'Provide an apikey query parameter');

    const key = await one<{ project_id: string; kind: string }>(
      'SELECT project_id, kind FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
      [sha256(q.apikey)],
    );
    if (!key) return close(4401, 'Invalid API key');

    let userId: string | null = null;
    let claims: Record<string, unknown> | null = null;
    if (q.token) {
      const project = await one<{ jwt_secret_enc: string; ref: string }>(
        'SELECT jwt_secret_enc, ref FROM projects WHERE id = $1',
        [key.project_id],
      );
      try {
        const verified = await verifyProjectToken(decrypt(project!.jwt_secret_enc), project!.ref, q.token);
        userId = verified.sub;
        claims = verified as unknown as Record<string, unknown>;
      } catch {
        return close(4401, 'Invalid project token');
      }
    }

    const subscription: Subscription = {
      socket,
      projectId: key.project_id,
      topics: new Set(),
      bypassRls: key.kind === 'service_role',
      userId,
      claims,
    };
    subscriptions.add(subscription);

    try {
      await ensureListener(key.project_id);
    } catch (err) {
      logger.error({ err, projectId: key.project_id }, 'Could not attach realtime listener');
      subscriptions.delete(subscription);
      return close(1011, 'Realtime is unavailable for this project');
    }

    socket.send(JSON.stringify({ type: 'connected', projectId: key.project_id }));

    socket.on('message', (raw: Buffer) => {
      let frame: { type?: string; schema?: string; table?: string };
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return socket.send(JSON.stringify({ type: 'error', message: 'Frames must be JSON' }));
      }

      const topic = `${frame.schema ?? 'public'}.${frame.table ?? '*'}`;
      if (frame.type === 'subscribe') {
        subscription.topics.add(topic);
        socket.send(JSON.stringify({ type: 'subscribed', topic }));
      } else if (frame.type === 'unsubscribe') {
        subscription.topics.delete(topic);
        socket.send(JSON.stringify({ type: 'unsubscribed', topic }));
      } else if (frame.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
      }
    });

    socket.on('close', () => {
      subscriptions.delete(subscription);
      void stopListenerIfIdle(key.project_id);
    });
  });

  app.get('/projects/:projectId/realtime/status', { preHandler: [app.requireProject('project.read')] }, async (req) => {
    const connected = [...subscriptions].filter((s) => s.projectId === req.project!.id);
    return {
      data: {
        connections: connected.length,
        listenerAttached: listeners.has(req.project!.id),
        topics: [...new Set(connected.flatMap((s) => [...s.topics]))],
      },
      error: null,
    };
  });
}

export async function shutdownRealtime(): Promise<void> {
  for (const [, client] of listeners) await client.end().catch(() => undefined);
  listeners.clear();
  subscriptions.clear();
}

/** Exported for tests that need an isolated subscriber. */
export const createSubscriberClient = () => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
