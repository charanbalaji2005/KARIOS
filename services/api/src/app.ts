import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { env } from './env.js';
import { logger } from './logger.js';
import { securityEvent, type SecurityEvent } from './lib/security-log.js';
import { ApiError } from './lib/errors.js';
import authPlugin from './plugins/auth.js';
import observabilityPlugin from './plugins/observability.js';
import authRoutes from './modules/auth.routes.js';
import projectRoutes from './modules/projects.routes.js';
import databaseRoutes from './modules/database.routes.js';
import sqlRoutes from './modules/sql.routes.js';
import restRoutes from './modules/rest.routes.js';
import storageRoutes from './modules/storage.routes.js';
import realtimeRoutes from './modules/realtime.js';
import operationsRoutes from './modules/operations.routes.js';
import healthRoutes from './modules/health.routes.js';
import serverRoutes from './modules/server.routes.js';
import quotaRoutes from './modules/quotas.routes.js';
import serverIdentityRoutes from './modules/server-identity.routes.js';
import adminServerRoutes from './modules/admin-server.routes.js';
import mfaRoutes from './modules/mfa.routes.js';
import oauthRoutes from './modules/oauth.routes.js';
import memberRoutes from './modules/members.routes.js';
import adminRoutes from './modules/admin.routes.js';
import openApiRoutes from './modules/openapi.routes.js';
import importExportRoutes from './modules/import-export.routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger as any,
    /**
     * `trustProxy: true` trusts every hop, which means any client can set
     * X-Forwarded-For and pick its own apparent IP — defeating rate limits and
     * letting it get an innocent address banned. Trust exactly the number of
     * proxies actually in front of us: 0 direct, 1 behind nginx, 2 behind
     * Cloudflare + nginx.
     */
    trustProxy: env.TRUST_PROXY_HOPS,
    bodyLimit: 10 * 1024 * 1024,
    genReqId: () => randomUUID(),
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // the API serves JSON; the dashboard sets its own CSP
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  /**
   * CORS.
   *
   * The previous policy reflected every origin *and* set
   * `credentials: true`, which is the combination that matters: it let any
   * website make cookie-bearing requests to the dashboard API on a logged-in
   * user's behalf. That is CSRF with extra steps.
   *
   * The two surfaces have genuinely different requirements, so they get
   * different rules rather than one permissive rule that suits neither:
   *
   *   dashboard API (/api/v1)  cookie-authenticated → strict origin list,
   *                            credentials allowed
   *   data plane (/rest, /storage) API-key authenticated → any origin may
   *                            call, credentials never allowed
   *
   * A public anon key in a browser is public by definition; the boundary there
   * is RLS, not the origin. But it must never be paired with cookies, or the
   * browser will attach the user's dashboard session to a third party's
   * request.
   */
  const dashboardOrigins = new Set(
    [env.FRONTEND_URL, ...(process.env['ADDITIONAL_ORIGINS'] ?? '').split(',')]
      .map((value) => value.trim().replace(/\/$/, ''))
      .filter(Boolean),
  );

  /**
   * LAN access is a first-class mode: the whole point of running this on your
   * own machine is reaching it from your phone on the same Wi-Fi. Private-range
   * origins are therefore allowed when KAIROS_NETWORK_MODE permits it, rather
   * than forcing people to disable CORS entirely to make that work.
   */
  const lanAllowed = (process.env['KAIROS_NETWORK_MODE'] ?? 'local') !== 'remote';
  const PRIVATE_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local)(:\d+)?$/i;

  await app.register(cors, {
    origin: (origin, done) => {
      // Same-origin and server-to-server calls arrive without an Origin header.
      if (!origin) return done(null, true);
      const normalised = origin.replace(/\/$/, '');
      if (dashboardOrigins.has(normalised)) return done(null, true);
      if (lanAllowed && PRIVATE_ORIGIN.test(normalised)) return done(null, true);
      // Not an error — just no CORS headers, so the browser blocks it. Throwing
      // here would turn a routine cross-origin probe into a 500 in the logs.
      done(null, false);
    },
    credentials: true,
    exposedHeaders: ['content-range'],
    maxAge: 600,
  });

  /**
   * Data-plane CORS, applied after the strict policy above so it wins for
   * these paths. Any origin may call with an API key; `credentials` stays off
   * so cookies are never attached.
   */
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url;
    if (!url.startsWith('/rest/v1') && !url.startsWith('/storage/v1')) return;
    const origin = req.headers.origin;
    if (!origin) return;
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'origin');
    reply.header('access-control-allow-headers', 'authorization, apikey, content-type, prefer, x-client-info');
    reply.header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    reply.header('access-control-expose-headers', 'content-range');
    // Deliberately NOT access-control-allow-credentials. See above.
    reply.removeHeader('access-control-allow-credentials');
  });

  await app.register(cookie, { secret: env.JWT_SECRET });
  await app.register(multipart, { limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1 } });
  await app.register(websocket);
  // Registered before the routes so every request is timed, including the
  // ones that fail in a preHandler.
  await app.register(observabilityPlugin);
  await app.register(authPlugin);

  await app.register(async (instance) => {
    await instance.register(healthRoutes);
    await instance.register(authRoutes, { prefix: '/api/v1' });
    await instance.register(projectRoutes, { prefix: '/api/v1' });
    await instance.register(databaseRoutes, { prefix: '/api/v1' });
    await instance.register(sqlRoutes, { prefix: '/api/v1' });
    await instance.register(operationsRoutes, { prefix: '/api/v1' });
    await instance.register(serverRoutes, { prefix: '/api/v1' });
    await instance.register(quotaRoutes, { prefix: '/api/v1' });
    await instance.register(serverIdentityRoutes, { prefix: '/api/v1' });
    await instance.register(adminServerRoutes, { prefix: '/api/v1' });
    await instance.register(mfaRoutes, { prefix: '/api/v1' });
    await instance.register(oauthRoutes, { prefix: '/api/v1' });
    await instance.register(memberRoutes, { prefix: '/api/v1' });
    await instance.register(adminRoutes, { prefix: '/api/v1' });
    await instance.register(openApiRoutes, { prefix: '/api/v1' });
    await instance.register(importExportRoutes, { prefix: '/api/v1' });
    await instance.register(storageRoutes, { prefix: '/api/v1' });
    await instance.register(restRoutes);
    await instance.register(realtimeRoutes);
  });

  /** One place decides what the client sees. Stack traces never leave the process. */
  /**
   * Error codes that fail2ban should hear about. Emitting these from one place
   * rather than from every throw site means a new route cannot forget to do it.
   */
  const SECURITY_CODES: Record<string, SecurityEvent> = {
    RATE_LIMITED: 'RATE_LIMITED',
    FORBIDDEN: 'FORBIDDEN',
    INVALID_PATH: 'PATH_TRAVERSAL',
    INVALID_IDENTIFIER: 'SQL_IDENTIFIER_REJECTED',
  };

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ApiError) {
      req.log.info({ code: error.code, msg: error.message }, 'Request rejected');
      const securityCode = SECURITY_CODES[error.code];
      if (securityCode) {
        securityEvent(securityCode, {
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          userId: req.user?.id,
          detail: `${req.method} ${req.routeOptions?.url ?? req.url}`,
        });
      }
      return reply.code(error.status).send({
        data: null,
        error: { code: error.code, message: error.message, details: error.details ?? undefined },
      });
    }

    if (error instanceof ZodError) {
      return reply.code(422).send({
        data: null,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Some fields need attention',
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }

    if ((error as { statusCode?: number }).statusCode === 413) {
      return reply.code(413).send({ data: null, error: { code: 'VALIDATION_ERROR', message: 'That file is too large' } });
    }

    req.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send({
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong on our side. The request id below will help us trace it.',
        details: { requestId: req.id },
      },
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ data: null, error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.url}` } }),
  );

  return app as unknown as FastifyInstance;
}
