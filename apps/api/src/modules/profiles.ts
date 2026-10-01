import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '@mediaradar/core';
import type { Queryable } from '@mediaradar/db';
import {
  ARTICLE_COLUMNS,
  ARTICLE_FROM,
  articleDto,
  buildArticleWhere,
  entitiesFor,
  loadPolicyResolver,
  tenantTz,
  type ArticleRow,
} from '../lib/content';
import { escapeLike, rangeBounds, rangeSchema, uuidParam } from '../lib/http';
import { MENTIONS_ENTITY, breakdowns, dailySeries, periodQuery, type Scope } from '../lib/stats';
import { requireAuth, tctx, type Access, type AuthContext } from '../plugins/auth';

const ENTITY_TYPES = ['person', 'org', 'place', 'event'] as const;
const rangeQuery = z.object({ range: rangeSchema });

/** Общая часть профиля: объём по суткам, распределения, последние материалы. Область задаёт, чей это профиль. */
async function profileCore(
  q: Queryable,
  a: AuthContext,
  range: z.infer<typeof rangeSchema>,
  scope: Scope,
  tenantTotal: boolean,
) {
  const { from, to, prevFrom } = rangeBounds(range);
  const tz = tenantTz(a);
  const daily = await dailySeries(q, a, from, to, tz, scope);
  const total = daily.reduce((s, d) => s + d.count, 0);
  const prevRows = await periodQuery<{ n: number }>(
    q,
    a,
    prevFrom,
    from,
    'count(*)::int AS n',
    scope.tail ?? '',
    scope.extra ?? [],
    scope.filter,
  );
  const stream = tenantTotal
    ? (await periodQuery<{ n: number }>(q, a, from, to, 'count(*)::int AS n', ''))[0]!.n
    : null;
  const parts = await breakdowns(q, a, from, to, tz, scope);

  const w = buildArticleWhere({ ...scope.filter, from, to }, a);
  const tail = (scope.tail ?? '').replace(/\{(\d+)\}/g, (_, i: string) => `$${w.params.length + Number(i)}`);
  const rows = (
    await q.query<ArticleRow>(
      `SELECT ${ARTICLE_COLUMNS} ${ARTICLE_FROM} WHERE ${w.sql} ${tail} ORDER BY a.published_at DESC, a.id DESC LIMIT 10`,
      [...w.params, ...(scope.extra ?? [])],
    )
  ).rows;
  const pr = await loadPolicyResolver(q, a.tenantId!);
  const ents = await entitiesFor(
    q,
    rows.map((x) => x.id),
  );
  return {
    range,
    from,
    to,
    timezone: tz,
    total,
    prevTotal: prevRows[0]!.n,
    share: stream ? Math.round((total / stream) * 1000) / 10 : null,
    daily,
    ...parts,
    latest: rows.map((row) => articleDto(row, pr, ents.get(row.id))),
  };
}

export async function profileRoutes(app: FastifyInstance, access: Access): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db } = app.deps;

  // ------------------------------------------------------------------------------------------------
  r.get(
    '/sources/:id/profile',
    { ...access.tenant('dashboard:read'), schema: { params: uuidParam, querystring: rangeQuery } },
    async (req) => {
      const a = requireAuth(req);
      return db.tenant(
        tctx(req),
        async (q) => {
          // видимость источника обеспечивает RLS: чужой или отключённый — «не найден»
          const src = (
            await q.query<{
              id: string;
              name: string;
              domain: string;
              url: string;
              kind: string;
              status: string;
              trust_score: number;
              last_run_at: Date | null;
              items_count: number;
            }>(
              'SELECT id, name, domain, url, kind, status, trust_score, last_run_at, items_count FROM sources WHERE id = $1',
              [req.params.id],
            )
          ).rows[0];
          if (!src) throw new AppError('not_found', 'Источник не найден');
          const scope: Scope = { filter: { sources: [src.id] } };
          const core = await profileCore(q, a, req.query.range, scope, true);
          const first = (
            await q.query<{ d: Date | null }>(
              "SELECT min(published_at) AS d FROM articles WHERE source_id = $1 AND status = 'published'",
              [src.id],
            )
          ).rows[0]!.d;
          // персоны и организации, которых источник упоминает чаще всего
          const w = buildArticleWhere({ ...scope.filter, from: rangeBounds(req.query.range).from }, a);
          const ents = (
            await q.query<{ id: string; name: string; type: string; count: number }>(
              `SELECT e.id, e.canonical_name AS name, e.type, count(DISTINCT a.id)::int AS count ${ARTICLE_FROM}
               JOIN article_entities ae ON ae.article_id = a.id JOIN entities e ON e.id = ae.entity_id AND e.type IN ('person', 'org')
               WHERE ${w.sql} GROUP BY e.id, e.canonical_name, e.type ORDER BY count DESC, name LIMIT 8`,
              w.params,
            )
          ).rows;
          return {
            source: {
              id: src.id,
              name: src.name,
              domain: src.domain,
              url: src.url,
              kind: src.kind,
              status: src.status,
              trust: src.trust_score,
              lastRunAt: src.last_run_at,
              itemsCount: src.items_count,
              firstPublishedAt: first,
            },
            ...core,
            entities: ents,
          };
        },
        { readOnly: true },
      );
    },
  );

  // ------------------------------------------------------------------------------------------------
  r.get(
    '/entities',
    {
      ...access.tenant('dashboard:read'),
      schema: {
        querystring: z.object({
          range: rangeSchema,
          type: z.enum(ENTITY_TYPES).default('person'),
          q: z.string().trim().max(100).optional(),
        }),
      },
    },
    async (req) => {
      const a = requireAuth(req);
      const { from, to } = rangeBounds(req.query.range);
      return db.tenant(
        tctx(req),
        async (q) => {
          const w = buildArticleWhere({ from, to }, a);
          const params = [...w.params, req.query.type];
          let name = '';
          if (req.query.q) {
            params.push(escapeLike(req.query.q));
            name = `AND e.canonical_name ILIKE '%' || $${params.length} || '%'`;
          }
          const rows = (
            await q.query<{ id: string; name: string; count: number; avg: number | null }>(
              `SELECT e.id, e.canonical_name AS name, count(DISTINCT a.id)::int AS count, avg(a.sentiment_score)::float AS avg ${ARTICLE_FROM}
               JOIN article_entities ae ON ae.article_id = a.id JOIN entities e ON e.id = ae.entity_id AND e.type = $${w.params.length + 1} ${name}
               WHERE ${w.sql} GROUP BY e.id, e.canonical_name ORDER BY count DESC, name LIMIT 100`,
              params,
            )
          ).rows;
          return {
            type: req.query.type,
            items: rows.map((x) => ({
              id: x.id,
              name: x.name,
              count: x.count,
              avgSentiment: x.avg === null ? null : Math.round(x.avg * 1000) / 1000,
            })),
          };
        },
        { readOnly: true },
      );
    },
  );

  r.get(
    '/entities/:id/profile',
    { ...access.tenant('dashboard:read'), schema: { params: uuidParam, querystring: rangeQuery } },
    async (req) => {
      const a = requireAuth(req);
      return db.tenant(
        tctx(req),
        async (q) => {
          const ent = (
            await q.query<{
              id: string;
              type: string;
              canonical_name: string;
              attributes: Record<string, unknown>;
            }>('SELECT id, type, canonical_name, attributes FROM entities WHERE id = $1', [req.params.id])
          ).rows[0];
          if (!ent) throw new AppError('not_found', 'Персона или организация не найдена');
          const scope: Scope = { tail: MENTIONS_ENTITY, extra: [ent.id] };
          const core = await profileCore(q, a, req.query.range, scope, true);
          // с кем и чем упоминается вместе: другие персоны и организации из тех же материалов
          const { from, to } = rangeBounds(req.query.range);
          const w = buildArticleWhere({ from, to }, a);
          const related = (
            await q.query<{ id: string; name: string; type: string; count: number }>(
              `SELECT e2.id, e2.canonical_name AS name, e2.type, count(DISTINCT a.id)::int AS count ${ARTICLE_FROM}
               JOIN article_entities ae1 ON ae1.article_id = a.id AND ae1.entity_id = $${w.params.length + 1}
               JOIN article_entities ae2 ON ae2.article_id = a.id AND ae2.entity_id <> ae1.entity_id
               JOIN entities e2 ON e2.id = ae2.entity_id AND e2.type IN ('person', 'org')
               WHERE ${w.sql} GROUP BY e2.id, e2.canonical_name, e2.type ORDER BY count DESC, name LIMIT 8`,
              [...w.params, ent.id],
            )
          ).rows;
          return {
            entity: {
              id: ent.id,
              type: ent.type,
              name: ent.canonical_name,
              attributes: ent.attributes,
            },
            ...core,
            related,
          };
        },
        { readOnly: true },
      );
    },
  );
}
