import type { FastifyRequest } from 'fastify';
import type { Db, Tx } from '../db/client.js';
import { auditLogs } from '../db/schema.js';

export interface Actor {
  type: 'user' | 'api_client' | 'system';
  id?: string;
  label?: string;
  ip?: string;
}

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  eventId?: string;
  targetUserId?: string;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
}

export const SYSTEM_ACTOR: Actor = { type: 'system', label: 'system' };

export function actorFromRequest(req: FastifyRequest): Actor {
  if (req.user) return { type: 'user', id: req.user.id, label: req.user.email, ip: req.ip };
  if (req.apiClient) return { type: 'api_client', id: req.apiClient.id, label: req.apiClient.name, ip: req.ip };
  return { type: 'system', label: 'anonymous', ip: req.ip };
}

const REDACT = /password|hash|secret|token|key/i;
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, REDACT.test(k) && !/^(keyPrefix|allowedEventIds)$/.test(k) ? '[redacted]' : redact(v)]));
  }
  return value;
}

/** Pass a transaction so the audit row commits atomically with the change it describes. */
export async function audit(db: Db | Tx, actor: Actor, entry: AuditEntry) {
  await db.insert(auditLogs).values({
    actorType: actor.type,
    actorId: actor.id,
    actorLabel: actor.label,
    ip: actor.ip,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    eventId: entry.eventId,
    targetUserId: entry.targetUserId,
    before: entry.before === undefined ? null : redact(entry.before),
    after: entry.after === undefined ? null : redact(entry.after),
    meta: entry.meta ?? null,
  });
}
