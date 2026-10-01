import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, ALERT_LEVELS } from '@mediaradar/core';
import type { Queryable } from '@mediaradar/db';
import { audit } from '../lib/audit';
import { assertFeature, assertWithinLimit, loadEntitlements, usageCounts } from '../lib/entitlements';
import { camel, camelAll, uuidParam } from '../lib/http';
import { requireAuth, tctx, type Access } from '../plugins/auth';

const word = z.string().trim().min(2).max(60);

/** Алерты, отчёты, тарифы и уведомления тенанта. */
export async function workspaceRoutes(app: FastifyInstance, access: Access): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db } = app.deps;

  // --- алерты -----------------------------------------------------------------------------------
  const alertBody = z.object({
    name: z.string().trim().min(3).max(120), level: z.enum(ALERT_LEVELS),
    keywords: z.array(word).min(1, 'Добавьте хотя бы одно ключевое слово').max(30),
    scope: z.array(z.string().trim().min(1).max(80)).max(30).default(['Все источники']),
    channels: z.array(z.enum(['Telegram', 'Email', 'SMS', 'PDF-дайджест'])).min(1, 'Выберите канал доставки').max(4),
  });

  r.get('/alerts', access.tenant('alert:manage_own'), async (req) =>
    db.tenant(tctx(req), async (q) => ({
      items: camelAll((await q.query(`SELECT id, name, level, keywords, scope_labels AS scope, channels, enabled, fired_count, created_by, created_at FROM alert_rules ORDER BY created_at`)).rows),
    }), { readOnly: true }));

  r.post('/alerts', { ...access.tenant('alert:manage_own', 'alert:manage_team'), schema: { body: alertBody } }, async (req, reply) => {
    const a = requireAuth(req);
    const id = await db.tenant(tctx(req), async (q) => {
      const ent = await loadEntitlements(q);
      const used = (await q.query<{ n: number }>('SELECT count(*)::int AS n FROM alert_rules')).rows[0]!.n;
      assertWithinLimit(ent, 'alerts.rules', used, 'правила алертов');
      const res = await q.query<{ id: string }>(
        'INSERT INTO alert_rules (tenant_id, name, level, keywords, scope_labels, channels, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [a.tenantId, req.body.name, req.body.level, req.body.keywords, req.body.scope, req.body.channels, a.userId]);
      await audit(q, req, { action: 'alert.created', objectType: 'alert_rule', objectId: res.rows[0]!.id, after: req.body });
      return res.rows[0]!.id;
    });
    return reply.status(201).send({ id });
  });

  async function loadOwnedRule(q: Queryable, id: string, a: ReturnType<typeof requireAuth>) {
    const rule = (await q.query<{ created_by: string | null; name: string }>('SELECT created_by, name FROM alert_rules WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!rule) throw new AppError('not_found', 'Правило не найдено');
    // личные правила меняет автор; командные — тот, у кого есть право alert:manage_team
    if (rule.created_by !== a.userId && !a.permissions.has('alert:manage_team')) throw new AppError('forbidden', 'Правило создал другой пользователь');
    return rule;
  }

  r.patch('/alerts/:id', { ...access.tenant('alert:manage_own', 'alert:manage_team'), schema: { params: uuidParam, body: z.object({ enabled: z.boolean() }) } }, async (req) => {
    const a = requireAuth(req);
    return db.tenant(tctx(req), async (q) => {
      const rule = await loadOwnedRule(q, req.params.id, a);
      await q.query('UPDATE alert_rules SET enabled = $2 WHERE id = $1', [req.params.id, req.body.enabled]);
      await audit(q, req, { action: req.body.enabled ? 'alert.enabled' : 'alert.disabled', objectType: 'alert_rule', objectId: req.params.id, after: { name: rule.name } });
      return { status: 'ok', enabled: req.body.enabled };
    });
  });

  r.delete('/alerts/:id', { ...access.tenant('alert:manage_own', 'alert:manage_team'), schema: { params: uuidParam } }, async (req) => {
    const a = requireAuth(req);
    return db.tenant(tctx(req), async (q) => {
      const rule = await loadOwnedRule(q, req.params.id, a);
      await q.query('DELETE FROM alert_rules WHERE id = $1', [req.params.id]);
      await audit(q, req, { action: 'alert.deleted', objectType: 'alert_rule', objectId: req.params.id, before: { name: rule.name } });
      return { status: 'ok' };
    });
  });

  // --- отчёты -----------------------------------------------------------------------------------
  r.get('/reports/templates', access.tenant('report:read'), async (req) =>
    db.tenant(tctx(req), async (q) => ({
      items: camelAll((await q.query('SELECT id, key, name, description, icon, color, tenant_id IS NULL AS is_system FROM report_templates ORDER BY tenant_id NULLS FIRST, created_at, name')).rows),
    }), { readOnly: true }));

  r.get('/reports/runs', access.tenant('report:read'), async (req) =>
    db.tenant(tctx(req), async (q) => ({
      items: camelAll((await q.query('SELECT id, name, type, period_from, period_to, status, format, size_bytes, error, created_at FROM report_runs ORDER BY created_at DESC LIMIT 100')).rows),
    }), { readOnly: true }));

  r.post('/reports/runs', {
    ...access.tenant('report:create'),
    schema: {
      body: z.object({
        templateKey: z.string().max(60), format: z.enum(['pdf', 'xlsx', 'pptx', 'csv', 'html']),
        from: z.coerce.date(), to: z.coerce.date(),
      }).refine((b) => b.from < b.to, 'Начало периода должно быть раньше конца'),
    },
  }, async (req, reply) => {
    const a = requireAuth(req);
    const run = await db.tenant(tctx(req), async (q) => {
      const ent = await loadEntitlements(q);
      if (req.body.format === 'pptx') assertFeature(ent, 'feature.pptx', 'Отчёты PowerPoint');
      const used = (await q.query<{ n: number }>("SELECT count(*)::int AS n FROM report_runs WHERE created_at >= date_trunc('month', now())")).rows[0]!.n;
      assertWithinLimit(ent, 'reports.per_month', used, 'отчёты в месяц');
      const tpl = (await q.query<{ id: string; name: string }>('SELECT id, name FROM report_templates WHERE key = $1 ORDER BY tenant_id NULLS LAST LIMIT 1', [req.body.templateKey])).rows[0];
      if (!tpl) throw new AppError('not_found', 'Шаблон отчёта не найден');
      const day = (d: Date) => d.toISOString().slice(0, 10);
      const res = await q.query(
        `INSERT INTO report_runs (tenant_id, template_id, name, type, period_from, period_to, status, format, created_by)
         VALUES ($1, $2, $3, $3, $4, $5, 'queued', $6, $7) RETURNING id, name, status, format, created_at`,
        [a.tenantId, tpl.id, tpl.name, day(req.body.from), day(req.body.to), req.body.format, a.userId]);
      const created = res.rows[0]!;
      await audit(q, req, { action: 'report.requested', objectType: 'report_run', objectId: created.id, after: req.body });
      return camel(created);
    });
    // Генерация файлов — Фаза 5: запрос сохраняется со статусом «в очереди».
    return reply.status(202).send({ ...run, implemented: false, note: 'Генерация PDF/Excel/PowerPoint реализуется в Фазе 5. Запрос сохранён в очереди.' });
  });

  // --- тарифы и использование ---------------------------------------------------------------------
  r.get('/billing/plans', access.tenant('tenant:read'), async (req) =>
    db.tenant(tctx(req), async (q) => ({
      items: camelAll((await q.query('SELECT key, name, price_minor, currency, interval, description, features, entitlements, sort FROM plans WHERE is_public ORDER BY sort')).rows),
    }), { readOnly: true }));

  r.get('/billing/subscription', access.tenant('tenant:read'), async (req) =>
    db.tenant(tctx(req), async (q) => {
      const ent = await loadEntitlements(q);
      const sub = (await q.query('SELECT status, period_start, period_end, trial_end, cancel_at FROM subscriptions LIMIT 1')).rows[0]!;
      const usage = await usageCounts(q);
      const meters = Object.entries(ent.entitlements).filter(([k]) => !k.startsWith('feature.')).map(([key, limit]) => ({ key, limit, used: usage[key] ?? 0 }));
      return { plan: { key: ent.planKey, name: ent.planName }, ...camel(sub), meters, features: Object.fromEntries(Object.entries(ent.entitlements).filter(([k]) => k.startsWith('feature.'))) };
    }, { readOnly: true }));

  r.get('/billing/payments', access.tenant('billing:manage'), async (req) =>
    db.tenant(tctx(req), async (q) => ({
      items: camelAll((await q.query('SELECT id, provider, description, method_label, amount_minor, currency, status, created_at FROM payments ORDER BY created_at DESC LIMIT 100')).rows),
    }), { readOnly: true }));

  r.post('/billing/checkout', { ...access.tenant('billing:manage'), schema: { body: z.object({ planKey: z.string().max(40) }) } }, async (_req, reply) =>
    reply.status(501).type('application/problem+json').send({
      type: 'about:blank', title: 'Не реализовано', status: 501, code: 'not_implemented',
      detail: 'Онлайн-оплата подключается в Фазе 8 (ЮKassa). Сейчас смена тарифа выполняется администратором платформы.',
    }));

  // --- уведомления --------------------------------------------------------------------------------
  r.get('/notifications', access.tenant('notification:read'), async (req) => {
    const a = requireAuth(req);
    return db.tenant(tctx(req), async (q) => {
      const rows = (await q.query('SELECT id, level, title, body, created_at, read_at FROM notifications WHERE user_id IS NULL OR user_id = $1 ORDER BY created_at DESC LIMIT 50', [a.userId])).rows;
      const items = camelAll<{ readAt: Date | null }>(rows);
      return { items, unread: items.filter((i) => !i.readAt).length };
    }, { readOnly: true });
  });

  r.post('/notifications/read-all', access.tenant('notification:read'), async (req) => {
    const a = requireAuth(req);
    return db.tenant(tctx(req), async (q) => {
      const res = await q.query('UPDATE notifications SET read_at = now() WHERE read_at IS NULL AND (user_id IS NULL OR user_id = $1)', [a.userId]);
      return { updated: res.rowCount };
    });
  });
}
