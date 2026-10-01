import type { FastifyRequest } from 'fastify';
import type { Queryable } from '@mediaradar/db';

export interface AuditEntry {
  action: string;
  objectType?: string;
  objectId?: string | null;
  before?: unknown;
  after?: unknown;
  /** Явный tenantId (по умолчанию — тенант запроса). null — платформенное событие. */
  tenantId?: string | null;
  actorId?: string | null;
  actorType?: 'user' | 'system' | 'api_key';
}

/** Пишет запись аудита в той же транзакции, что и изменение. Секреты в before/after не передавать. */
export async function audit(q: Queryable, req: FastifyRequest | null, e: AuditEntry): Promise<void> {
  const tenantId = e.tenantId === undefined ? (req?.auth?.tenantId ?? null) : e.tenantId;
  await q.query(
    `INSERT INTO audit_log (tenant_id, actor_id, actor_type, action, object_type, object_id, before, after, ip, user_agent, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      tenantId,
      e.actorId === undefined ? (req?.auth?.userId ?? null) : e.actorId,
      e.actorType ?? 'user',
      e.action,
      e.objectType ?? null,
      e.objectId ?? null,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      req?.ip ?? null,
      req?.headers['user-agent']?.slice(0, 300) ?? null,
      req?.id ?? null,
    ],
  );
}
