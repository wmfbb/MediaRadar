import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '@mediaradar/core';
import { audit } from '../lib/audit';
import { camelAll } from '../lib/http';
import { requireAuth, type Access } from '../plugins/auth';

/** Платформенные операции (SUPER_ADMIN, SUPPORT и др. — по разрешениям). Работают в платформенном контексте БД. */
export async function adminRoutes(app: FastifyInstance, access: Access): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db } = app.deps;

  r.get('/admin/tenants', access.platform('platform:tenants'), async (req) => {
    const a = requireAuth(req);
    return db.platform(a.userId, async (q) => ({
      items: camelAll((await q.query(
        `SELECT t.id, t.slug, t.name, t.status, t.created_at, s.plan_key, s.status AS plan_status,
                (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id AND m.status = 'active') AS members,
                (SELECT count(*)::int FROM tenant_sources ts WHERE ts.tenant_id = t.id AND ts.enabled) AS sources
           FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id ORDER BY t.created_at`)).rows),
    }), { readOnly: true });
  });

  r.patch('/admin/tenants/:id', {
    ...access.platform('platform:settings'),
    schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ status: z.enum(['active', 'suspended', 'archived']) }) },
  }, async (req) => {
    const a = requireAuth(req);
    return db.platform(a.userId, async (q) => {
      const before = (await q.query<{ status: string }>('SELECT status FROM tenants WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!before) throw new AppError('not_found', 'Тенант не найден');
      await q.query('UPDATE tenants SET status = $2 WHERE id = $1', [req.params.id, req.body.status]);
      await audit(q, req, { tenantId: req.params.id, action: 'platform.tenant_status_changed', objectType: 'tenant', objectId: req.params.id, before, after: req.body });
      return { status: 'ok' };
    });
  });

  r.get('/admin/audit', {
    ...access.platform('platform:audit'),
    schema: { querystring: z.object({ tenantId: z.string().uuid().optional(), action: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.date().optional() }) },
  }, async (req) => {
    const a = requireAuth(req);
    const { tenantId, action, limit, before } = req.query;
    return db.platform(a.userId, async (q) => {
      const res = await q.query(
        `SELECT l.id, l.ts, l.tenant_id, t.name AS tenant_name, l.actor_id, u.display_name AS actor_name, l.actor_type, l.action, l.object_type, l.object_id, l.ip
           FROM audit_log l LEFT JOIN tenants t ON t.id = l.tenant_id LEFT JOIN users u ON u.id = l.actor_id
          WHERE ($1::uuid IS NULL OR l.tenant_id = $1) AND ($2::text IS NULL OR l.action LIKE $2 || '%') AND ($3::timestamptz IS NULL OR l.ts < $3)
          ORDER BY l.ts DESC, l.id DESC LIMIT $4`, [tenantId ?? null, action ?? null, before ?? null, limit]);
      const items = camelAll<{ ts: Date }>(res.rows);
      return { items, nextBefore: items.length === limit ? items[items.length - 1]!.ts : null };
    }, { readOnly: true });
  });

  r.get('/admin/flags', access.platform('platform:flags'), async (req) => {
    const a = requireAuth(req);
    return db.platform(a.userId, async (q) => ({ items: camelAll((await q.query('SELECT key, enabled, description, updated_at FROM feature_flags ORDER BY key')).rows) }), { readOnly: true });
  });

  r.put('/admin/flags/:key', {
    ...access.platform('platform:flags'),
    schema: { params: z.object({ key: z.string().min(2).max(80) }), body: z.object({ enabled: z.boolean() }) },
  }, async (req) => {
    const a = requireAuth(req);
    return db.platform(a.userId, async (q) => {
      // прикладной роли API запрещена запись в feature_flags: флаги — платформенный справочник, меняется через функцию с правами владельца
      const res = await q.query('SELECT set_feature_flag($1, $2) AS ok', [req.params.key, req.body.enabled]);
      if (!res.rows[0]?.ok) throw new AppError('not_found', 'Флаг не найден');
      await audit(q, req, { tenantId: null, action: 'platform.flag_changed', objectType: 'feature_flag', objectId: req.params.key, after: req.body });
      return { status: 'ok' };
    });
  });
}
