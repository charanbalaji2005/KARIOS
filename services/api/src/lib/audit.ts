import type { FastifyRequest } from 'fastify';
import { query } from '../db/platform.js';
import { logger } from '../logger.js';

export interface AuditEvent {
  actorId?: string | null;
  organizationId?: string | null;
  projectId?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Audit writes must never break the operation they describe, so failures are
 * logged rather than thrown. They are also never awaited on the hot path.
 */
export async function audit(req: FastifyRequest | null, event: AuditEvent): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs
         (actor_id, organization_id, project_id, action, resource_type, resource_id, metadata, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        event.actorId ?? req?.user?.id ?? null,
        event.organizationId ?? null,
        event.projectId ?? null,
        event.action,
        event.resourceType ?? null,
        event.resourceId ?? null,
        JSON.stringify(event.metadata ?? {}),
        req?.ip ?? null,
        req?.headers['user-agent'] ?? null,
      ],
    );
  } catch (err) {
    logger.error({ err, action: event.action }, 'Failed to write audit log');
  }
}
