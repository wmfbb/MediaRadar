import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, SENTIMENTS, SOURCE_KINDS } from '@mediaradar/core';
import { audit } from '../lib/audit';
import {
  ARTICLE_COLUMNS, ARTICLE_FROM, articleDto, articleFilterSchema, buildArticleWhere, entitiesFor, loadPolicyResolver, truncate,
  type ArticleRow, type FacetKey,
} from '../lib/content';
import { camelAll, uuidParam } from '../lib/http';
import { requireAuth, tctx, type Access } from '../plugins/auth';

const listQuery = articleFilterSchema.extend({
  sort: z.enum(['date', 'old', 'sent', 'src']).default('date'),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  cursor: z.string().max(200).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

const encodeCursor = (t: Date, id: string) => Buffer.from(JSON.stringify([t.toISOString(), id])).toString('base64url');
function decodeCursor(c: string): [Date, string] {
  try {
    const [t, id] = JSON.parse(Buffer.from(c, 'base64url').toString()) as [string, string];
    const d = new Date(t);
    if (Number.isNaN(d.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error();
    return [d, id];
  } catch {
    throw new AppError('bad_request', 'Некорректный курсор');
  }
}

export async function feedRoutes(app: FastifyInstance, access: Access): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db } = app.deps;

  r.get('/articles', { ...access.tenant('feed:read'), schema: { querystring: listQuery } }, async (req) => {
    const a = requireAuth(req);
    const { sort, limit, cursor, offset, ...filter } = req.query;
    return db.tenant(tctx(req), async (q) => {
      const base = buildArticleWhere(filter, a);
      const total = (await q.query<{ n: number }>(`SELECT count(*)::int AS n ${ARTICLE_FROM} WHERE ${base.sql}`, base.params)).rows[0]!.n;

      const params = [...base.params];
      let where = base.sql;
      let order: string;
      let page = '';
      if (sort === 'date' || sort === 'old') {
        const dir = sort === 'date' ? 'DESC' : 'ASC';
        order = `a.published_at ${dir}, a.id ${dir}`;
        if (cursor) {
          const [t, id] = decodeCursor(cursor);
          params.push(t, id);
          where += ` AND (a.published_at, a.id) ${sort === 'date' ? '<' : '>'} ($${params.length - 1}, $${params.length})`;
        }
      } else {
        order = sort === 'sent' ? 'a.sentiment_score ASC NULLS LAST, a.published_at DESC, a.id DESC' : 's.name, a.published_at DESC, a.id DESC';
        page = ` OFFSET ${offset}`;
      }
      params.push(limit + 1);
      const rows = (await q.query<ArticleRow>(`SELECT ${ARTICLE_COLUMNS} ${ARTICLE_FROM} WHERE ${where} ORDER BY ${order} LIMIT $${params.length}${page}`, params)).rows;
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      // Запросы идут последовательно: tenant-транзакция — одно соединение, параллельные q.query() на нём устарели в pg.
      const pr = await loadPolicyResolver(q, a.tenantId!);
      const ents = await entitiesFor(q, pageRows.map((x) => x.id));
      const items = pageRows.map((row) => articleDto(row, pr, ents.get(row.id)));
      const last = pageRows[pageRows.length - 1];
      return {
        items, total,
        nextCursor: hasMore && (sort === 'date' || sort === 'old') && last ? encodeCursor(last.published_at, last.id) : null,
        nextOffset: hasMore && (sort === 'sent' || sort === 'src') ? offset + limit : null,
      };
    }, { readOnly: true });
  });

  // Фасеты: счётчики значений при применённых остальных фильтрах (каждый фасет не учитывает собственный фильтр)
  r.get('/articles/facets', { ...access.tenant('feed:read'), schema: { querystring: articleFilterSchema } }, async (req) => {
    const a = requireAuth(req);
    const f = req.query;
    return db.tenant(tctx(req), async (q) => {
      const run = async (exclude: FacetKey, select: string, group: string, extraWhere = '', limit = 50) => {
        const w = buildArticleWhere(f, a, { exclude });
        return (await q.query(`SELECT ${select}, count(*)::int AS count ${ARTICLE_FROM} WHERE ${w.sql}${extraWhere} GROUP BY ${group} ORDER BY count DESC LIMIT ${limit}`, w.params)).rows;
      };
      const topics = await run('topics', 't.key, t.name, t.color', 't.key, t.name, t.color', ' AND t.key IS NOT NULL');
      const kinds = await run('kinds', 's.kind AS key', 's.kind');
      const sentiment = await run('sentiment', 'a.sentiment_label AS key', 'a.sentiment_label', ' AND a.sentiment_label IS NOT NULL');
      const geo = await run('geo', 'g.name', 'g.name', ' AND g.name IS NOT NULL', 14);
      const sources = await run('sources', 's.id, s.name, s.domain', 's.id, s.name, s.domain', '', 20);
      const allTopics = await q.query<{ key: string; name: string; color: string }>('SELECT key, name, color FROM topics ORDER BY sort, name');
      const cnt = (rows: Array<Record<string, unknown>>, key: string) => new Map(rows.map((x) => [x[key] as string, x.count as number]));
      const tc = cnt(topics, 'key');
      const kc = cnt(kinds, 'key');
      const sc = cnt(sentiment, 'key');
      return {
        topics: allTopics.rows.map((t) => ({ ...t, count: tc.get(t.key) ?? 0 })),
        kinds: (Object.keys(SOURCE_KINDS) as Array<keyof typeof SOURCE_KINDS>).map((k) => ({ key: k, label: SOURCE_KINDS[k], count: kc.get(k) ?? 0 })),
        sentiment: (Object.keys(SENTIMENTS) as Array<keyof typeof SENTIMENTS>).map((k) => ({ key: k, label: SENTIMENTS[k].label, count: sc.get(k) ?? 0 })),
        geo: geo.map((x) => ({ name: x.name, count: x.count })),
        sources: sources.map((x) => ({ id: x.id, name: x.name, domain: x.domain, count: x.count })),
      };
    }, { readOnly: true });
  });

  r.get('/articles/:id', { ...access.tenant('feed:read'), schema: { params: uuidParam } }, async (req) => {
    const a = requireAuth(req);
    return db.tenant(tctx(req), async (q) => {
      const w = buildArticleWhere({}, a, { startAt: 2 });
      const row = (await q.query<ArticleRow & { body_text: string | null }>(
        `SELECT ${ARTICLE_COLUMNS}, tx.body_text ${ARTICLE_FROM} LEFT JOIN article_texts tx ON tx.article_id = a.id WHERE a.id = $1 AND ${w.sql}`, [req.params.id, ...w.params])).rows[0];
      if (!row) throw new AppError('not_found', 'Материал не найден');
      const pr = await loadPolicyResolver(q, a.tenantId!);
      const ents = await entitiesFor(q, [row.id]);
      const dto = articleDto(row, pr, ents.get(row.id));
      const body = dto.policy === 'full' ? row.body_text : null;
      const rel = buildArticleWhere({}, a, { startAt: 3 });
      const related = (await q.query<ArticleRow>(
        `SELECT ${ARTICLE_COLUMNS} ${ARTICLE_FROM} WHERE a.id <> $1 AND a.topic_id IS NOT DISTINCT FROM $2 AND ${rel.sql} ORDER BY a.published_at DESC LIMIT 5`,
        [row.id, (await q.query<{ topic_id: string | null }>('SELECT topic_id FROM articles WHERE id = $1', [row.id])).rows[0]!.topic_id, ...rel.params])).rows;
      return {
        ...dto,
        body,
        // для политики «заголовок + лид + ссылка» тело не отдаётся вовсе; лид уже усечён по настройке
        summary: dto.policy === 'metadata' ? null : truncate(row.lead, 300),
        related: related.map((x) => articleDto(x, pr)),
      };
    }, { readOnly: true });
  });

  // --- сохранённые фильтры ------------------------------------------------------------------------
  const savedFilterBody = z.object({
    name: z.string().trim().min(1).max(120),
    visibility: z.enum(['private', 'team']).default('private'),
    filter: z.object({
      q: z.string().max(200).optional(), from: z.string().max(40).optional(), to: z.string().max(40).optional(),
      topics: z.array(z.string()).max(30).optional(), sources: z.array(z.string()).max(60).optional(), kinds: z.array(z.string()).max(10).optional(),
      sentiment: z.array(z.string()).max(5).optional(), geo: z.array(z.string()).max(60).optional(), entities: z.array(z.string()).max(30).optional(),
    }),
  });

  r.get('/saved-filters', access.tenant('filter:manage_own'), async (req) => {
    const a = requireAuth(req);
    return db.tenant(tctx(req), async (q) => ({
      items: camelAll((await q.query(
        `SELECT f.id, f.name, f.filter, f.visibility, f.created_at, f.user_id = $1 AS mine, u.display_name AS author
           FROM saved_filters f LEFT JOIN users u ON u.id = f.user_id WHERE f.user_id = $1 OR f.visibility = 'team' ORDER BY f.created_at DESC`, [a.userId])).rows),
    }), { readOnly: true });
  });

  r.post('/saved-filters', { ...access.tenant('filter:manage_own'), schema: { body: savedFilterBody } }, async (req, reply) => {
    const a = requireAuth(req);
    if (req.body.visibility === 'team' && !a.permissions.has('dashboard:build_team')) throw new AppError('forbidden', 'Командные фильтры могут создавать аналитики и администраторы');
    const row = await db.tenant(tctx(req), async (q) => {
      const res = await q.query<{ id: string }>('INSERT INTO saved_filters (tenant_id, user_id, name, filter, visibility) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [a.tenantId, a.userId, req.body.name, JSON.stringify(req.body.filter), req.body.visibility]);
      await audit(q, req, { action: 'filter.created', objectType: 'saved_filter', objectId: res.rows[0]!.id, after: { name: req.body.name } });
      return res.rows[0]!;
    });
    return reply.status(201).send(row);
  });

  r.delete('/saved-filters/:id', { ...access.tenant('filter:manage_own'), schema: { params: uuidParam } }, async (req) => {
    const a = requireAuth(req);
    return db.tenant(tctx(req), async (q) => {
      const res = await q.query('DELETE FROM saved_filters WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, a.userId]);
      if (!res.rowCount) throw new AppError('not_found', 'Фильтр не найден');
      return { status: 'ok' };
    });
  });
}
