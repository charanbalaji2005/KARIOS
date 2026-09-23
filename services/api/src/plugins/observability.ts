/**
 * Request timing and trace propagation.
 *
 * Two things, both cheap:
 *
 *  1. Every request is timed into a histogram, labelled by route pattern and
 *     status class. That is what makes p50/p95/p99 per endpoint real rather
 *     than a promise in a README.
 *
 *  2. A W3C `traceparent` is accepted or created and echoed back, and the
 *     trace id is attached to the log line. That is the useful 20% of
 *     distributed tracing without an OpenTelemetry collector: one id that
 *     joins the nginx log, the API log and the query log for a single request.
 *
 * A full OTLP exporter is deliberately not here. It needs a collector process,
 * and a collector that is not running silently drops spans — which looks
 * exactly like tracing working until you need it.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { metrics, normaliseRoute } from '../lib/metrics.js';

declare module 'fastify' {
  interface FastifyRequest {
    traceId?: string;
    spanId?: string;
    startedAt?: bigint;
  }
}

/** W3C trace-context: version-traceid-spanid-flags. */
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export default fp(async (app: FastifyInstance) => {
  app.addHook('onRequest', async (req: FastifyRequest) => {
    req.startedAt = process.hrtime.bigint();

    const incoming = req.headers['traceparent'];
    const match = typeof incoming === 'string' ? TRACEPARENT.exec(incoming) : null;

    // Continue an upstream trace when one arrives, otherwise start one. A
    // client-supplied trace id is not trusted for anything but correlation —
    // it never reaches a query or an authorization decision.
    req.traceId = match?.[1] ?? randomBytes(16).toString('hex');
    req.spanId = randomBytes(8).toString('hex');
  });

  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.startedAt) return;
    const durationMs = Number(process.hrtime.bigint() - req.startedAt) / 1_000_000;

    const route = normaliseRoute(req.url, req.routeOptions?.url);
    const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;

    metrics.observe('kairos_http_request_duration_seconds', durationMs, { route, method: req.method });
    metrics.increment('kairos_http_requests_total', { route, method: req.method, status: statusClass });
    if (reply.statusCode >= 500) {
      metrics.increment('kairos_http_errors_total', { route, method: req.method });
    }

    // Only log slow or failed requests in full. Logging every request at info
    // on a laptop fills the disk that the database needs.
    if (durationMs > 1000 || reply.statusCode >= 500) {
      req.log.warn(
        { traceId: req.traceId, route, method: req.method, status: reply.statusCode, durationMs: Math.round(durationMs) },
        durationMs > 1000 ? 'slow request' : 'request failed',
      );
    }
  });

  // Echo the trace id so a caller can quote it in a bug report and it can be
  // found in the logs.
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload) => {
    if (req.traceId) {
      reply.header('traceparent', `00-${req.traceId}-${req.spanId}-01`);
      reply.header('x-trace-id', req.traceId);
    }
    return payload;
  });
});
