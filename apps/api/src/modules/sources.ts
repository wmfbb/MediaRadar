import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, PARSERS, SOURCE_KINDS, type SourceKind } from '@mediaradar/core';
import type { Queryable } from '@mediaradar/db';
import { audit } from '../lib/audit';
import { assertFeature, assertWithinLimit, loadEntitlements } from '../lib/entitlements';
import { camel, uuidParam } from '../lib/http';
import { assertPublicHttpUrl } from '../lib/url-safety';
import { requireAuth, tctx, type Access } from '../plugins/auth';

const CRON_RE = /^(\S+\s+){4}\S+$/;
const kindEnum = z.enum(Object.keys(SOURCE_KINDS) as [SourceKind, ...SourceKind[]]);

const DEFAULT_CONFIG: Record<string, object> = {
  PLAYWRIGHT: { connector: 'html-browser', list: { itemSelector: 'article', linkSelector: 'a' }, article: { title: 'h1', body: 'article' }, render: { mode: 'browser' } },
  CHEERIO: { connector: 'html-static', list: { itemSelector: 'article', linkSelector: 'a' }, article: { title: 'h1', body: 'article' }, render: { mode: 'static' } },
  RSS: { connector: 'rss', feedUrl: 'auto', stripHtml: true },
  TELEGRAM_BOT: { connector: 'telegram-web', channel: 'auto' },
  VK_API: { connector: 'vk', method: 'wall.get' },
  YOUTUBE_API: { connector: 'youtube' },
};

const SOURCE_SELECT = `s.id, s.name, s.url, s.domain, s.kind, s.parser, s.cron, s.status, s.trust_score, s.content_policy, s.items_count, s.last_run_at, s.last_error,
  s.error_count, s.owner_tenant_id, s.meta, ts.enabled, g.name AS city, t.key AS topic_key, t.name AS topic_name, t.color AS topic_color`;
const SOURCE_FROM = `FROM tenant_sources ts JOIN sources s ON s.id = ts.source_id LEFT JOIN geo_places g ON g.id = s.geo_id LEFT JOIN topics t ON t.id = s.topic_id`;

function sourceDto(row: Record<string, unknown>) {
  const { topicKey, topicName, topicColor, ownerTenantId, meta, enabled, status, trustScore, itemsCount, ...rest } = camel<Record<string, unknown>>(row);
  return {
    ...rest,
    itemsCount: itemsCount as number,
    // тенант может поставить на паузу свою подписку на общий источник
    status: enabled === false ? 'paused' : status,
    sourceStatus: status,
    enabled,
    trust: trustScore,
    topic: topicKey ? { key: topicKey, name: topicName, color: topicColor } : null,
    isPrivate: ownerTenantId !== null,
    demo: (meta as { demo?: boolean } | null)?.demo === true,
  };
}

export async function sourcesRoutes(app: FastifyInstance, access: Access): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, jobs } = app.deps;

  r.get('/sources', access.tenant('source:read'), async (req) =>
    db.tenant(tctx(req), async (q) => {
      const rows = (await q.query(`SELECT ${SOURCE_SELECT} ${SOURCE_FROM} ORDER BY s.items_count DESC, s.name`)).rows;
      const items = rows.map(sourceDto);
      return {
        items,
        kpis: {
          total: items.length,
          active: items.filter((s) => s.status === 'active').length,
          errors: items.filter((s) => s.status === 'error' || s.status === 'needs_attention').length,
          collected: items.reduce((sum, s) => sum + s.itemsCount, 0),
        },
      };
    }, { readOnly: true }));

  async function loadOne(q: Queryable, id: string) {
    const row = (await q.query(`SELECT ${SOURCE_SELECT} ${SOURCE_FROM} WHERE s.id = $1`, [id])).rows[0];
    if (!row) throw new AppError('not_found', 'Источник не найден');
    return row;
  }

  r.get('/sources/:id', { ...access.tenant('source:read'), schema: { params: uuidParam } }, async (req) =>
    db.tenant(tctx(req), async (q) => {
      const src = sourceDto(await loadOne(q, req.params.id));
      const versions = (await q.query<{ id: string; version: number; note: string | null; is_active: boolean; created_at: Date; config: object }>(
        'SELECT id, version, note, is_active, created_at, config FROM source_configs WHERE source_id = $1 ORDER BY version DESC', [req.params.id])).rows;
      return { ...src, config: versions.find((v) => v.is_active)?.config ?? null, versions: versions.map((v) => ({ id: v.id, version: v.version, note: v.note, isActive: v.is_active, createdAt: v.created_at })) };
    }, { readOnly: true }));

  r.post('/sources', {
    ...access.tenant('source:manage_private'),
    schema: {
      body: z.object({
        name: z.string().trim().min(2).max(120), url: z.string().trim().max(500), kind: kindEnum, parser: z.enum(PARSERS),
        cron: z.string().trim().regex(CRON_RE, 'Cron из 5 полей, например */15 * * * *').default('*/15 * * * *'),
        topicKey: z.string().max(60).optional(), city: z.string().max(80).optional(),
      }),
    },
  }, async (req, reply) => {
    const u = assertPublicHttpUrl(req.body.url);
    const a = requireAuth(req);
    const id = await db.tenant(tctx(req), async (q) => {
      const ent = await loadEntitlements(q);
      assertFeature(ent, 'feature.private_sources', 'Приватные источники');
      const used = (await q.query<{ n: number }>('SELECT count(*)::int AS n FROM tenant_sources WHERE enabled')).rows[0]!.n;
      assertWithinLimit(ent, 'sources.active', used, 'источники');
      const topic = req.body.topicKey ? (await q.query<{ id: string }>('SELECT id FROM topics WHERE key = $1 ORDER BY tenant_id NULLS LAST LIMIT 1', [req.body.topicKey])).rows[0] : undefined;
      const geo = req.body.city ? (await q.query<{ id: string }>('SELECT id FROM geo_places WHERE name = $1 LIMIT 1', [req.body.city])).rows[0] : undefined;
      // для соцсетей источник — конкретный канал/сообщество: домен включает путь (t.me/channel)
      const domain = u.hostname + (['TELEGRAM', 'VK', 'YOUTUBE'].includes(req.body.kind) ? u.pathname.replace(/\/$/, '') : '');
      const ins = (await q.query<{ id: string }>(
        `INSERT INTO sources (owner_tenant_id, kind, name, url, domain, geo_id, topic_id, parser, cron, status, trust_score, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', 50, '{}') RETURNING id`,
        [a.tenantId, req.body.kind, req.body.name, u.toString(), domain.toLowerCase(), geo?.id ?? null, topic?.id ?? null, req.body.parser, req.body.cron])).rows[0]!;
      await q.query('INSERT INTO tenant_sources (tenant_id, source_id) VALUES ($1, $2)', [a.tenantId, ins.id]);
      await q.query('INSERT INTO source_configs (source_id, version, config, author_id, note) VALUES ($1, 1, $2, $3, $4)', [ins.id, JSON.stringify(DEFAULT_CONFIG[req.body.parser]), a.userId, 'Создан вручную']);
      await audit(q, req, { action: 'source.created', objectType: 'source', objectId: ins.id, after: { name: req.body.name, url: u.toString(), parser: req.body.parser } });
      return ins.id;
    });
    return reply.status(201).send({ id });
  });

  r.patch('/sources/:id', { ...access.tenant('source:manage_private'), schema: { params: uuidParam, body: z.object({ enabled: z.boolean() }) } }, async (req) =>
    db.tenant(tctx(req), async (q) => {
      const a = requireAuth(req);
      const res = await q.query('UPDATE tenant_sources SET enabled = $2 WHERE source_id = $1 AND tenant_id = $3 RETURNING source_id', [req.params.id, req.body.enabled, a.tenantId]);
      if (!res.rowCount) throw new AppError('not_found', 'Источник не найден');
      await audit(q, req, { action: req.body.enabled ? 'source.resumed' : 'source.paused', objectType: 'source', objectId: req.params.id });
      return { status: 'ok', enabled: req.body.enabled };
    }));

  r.post('/sources/:id/run', { ...access.tenant('source:manage_private'), schema: { params: uuidParam } }, async (req, reply) => {
    const a = requireAuth(req);
    const src = await db.tenant(tctx(req), async (q) => {
      const row = await loadOne(q, req.params.id);
      await audit(q, req, { action: 'source.run_requested', objectType: 'source', objectId: req.params.id });
      return row as { id: string; domain: string };
    }, { readOnly: false });
    const queued = await jobs.enqueue('collect', 'run-source', { sourceId: src.id, tenantId: a.tenantId, requestedBy: a.userId });
    // Обработчик сбора появится в Фазе 1: сейчас задание принимается очередью, но данные не собирает.
    return reply.status(202).send({ queued, implemented: false, note: 'Сбор данных реализуется в Фазе 1. Задание поставлено в очередь.' });
  });

  r.put('/sources/:id/config', {
    ...access.tenant('source:manage_private'),
    schema: { params: uuidParam, body: z.object({ config: z.record(z.string(), z.unknown()), note: z.string().trim().max(300).optional() }) },
  }, async (req) => {
    if (typeof req.body.config.connector !== 'string') throw new AppError('validation_failed', 'В конфигурации нужно поле connector', [{ path: 'config.connector', message: 'обязательное поле' }]);
    if (JSON.stringify(req.body.config).length > 20_000) throw new AppError('validation_failed', 'Конфигурация слишком большая');
    const a = requireAuth(req);
    return db.tenant(tctx(req), async (q) => {
      // RLS разрешает менять конфиги только собственных (приватных) источников тенанта
      const own = (await q.query('SELECT 1 FROM sources WHERE id = $1 AND owner_tenant_id = $2', [req.params.id, a.tenantId])).rowCount;
      if (!own) throw new AppError('forbidden', 'Конфигурацию общих источников каталога меняет администратор платформы');
      const v = (await q.query<{ n: number }>('SELECT coalesce(max(version), 0)::int + 1 AS n FROM source_configs WHERE source_id = $1', [req.params.id])).rows[0]!.n;
      await q.query('UPDATE source_configs SET is_active = false WHERE source_id = $1', [req.params.id]);
      await q.query('INSERT INTO source_configs (source_id, version, config, author_id, note) VALUES ($1, $2, $3, $4, $5)', [req.params.id, v, JSON.stringify(req.body.config), a.userId, req.body.note ?? null]);
      await audit(q, req, { action: 'source.config_updated', objectType: 'source', objectId: req.params.id, after: { version: v, note: req.body.note } });
      return { version: v };
    });
  });
}
