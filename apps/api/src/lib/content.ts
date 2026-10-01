import type { Queryable } from '@mediaradar/db';
import { loadSettingRows } from '@mediaradar/db';
import { resolveSetting, requireDefinition } from '@mediaradar/settings';
import type { SENTIMENTS} from '@mediaradar/core';
import { SOURCE_KINDS, type ContentPolicy, type SourceKind } from '@mediaradar/core';
import { z } from 'zod';
import { csv, escapeLike } from './http';
import type { AuthContext } from '../plugins/auth';

/** Параметры фильтра ленты — единый DSL для интерфейса, API и алертов (PRODUCT_SPEC §4). */
export const articleFilterSchema = z.object({
  q: z.string().trim().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  topics: csv,
  sources: csv,
  kinds: csv,
  sentiment: csv,
  geo: csv,
  entities: csv,
});
export type ArticleFilter = z.infer<typeof articleFilterSchema>;
export type FacetKey = 'topics' | 'sources' | 'kinds' | 'sentiment' | 'geo';

/**
 * Запрос для поиска по префиксу основы: у слов длиннее 4 букв отбрасываются 1–2 последние буквы (падежные окончания),
 * остальное ищется как префикс. Разрешены только буквы и цифры — управляющие символы tsquery исключены.
 */
export function prefixQuery(q: string): string | null {
  const tokens = q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  if (!tokens.length) return null;
  return tokens.slice(0, 8).map((t) => `${t.length >= 7 ? t.slice(0, -2) : t.length >= 4 ? t.slice(0, -1) : t}:*`).join(' & ');
}

export const ARTICLE_FROM = `FROM articles a
  JOIN sources s ON s.id = a.source_id
  LEFT JOIN topics t ON t.id = a.topic_id
  LEFT JOIN geo_places g ON g.id = a.geo_id`;

/**
 * Собирает WHERE по фильтру. Видимость материалов обеспечивает RLS; здесь — пользовательские условия
 * и ограничение области (ABAC) из членства. exclude — фасет, не учитываемый при подсчёте его же значений.
 */
export function buildArticleWhere(f: Partial<ArticleFilter>, auth: AuthContext, opts: { exclude?: FacetKey; startAt?: number } = {}): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const next = (v: unknown) => `$${(opts.startAt ?? 1) + params.push(v) - 1}`;
  const where: string[] = ["a.status = 'published'"];
  if (f.from) where.push(`a.published_at >= ${next(f.from)}`);
  if (f.to) where.push(`a.published_at < ${next(f.to)}`);
  if (f.topics?.length && opts.exclude !== 'topics') where.push(`t.key = ANY(${next(f.topics)}::text[])`);
  if (f.sources?.length && opts.exclude !== 'sources') where.push(`a.source_id = ANY(${next(f.sources)}::uuid[])`);
  if (f.kinds?.length && opts.exclude !== 'kinds') where.push(`s.kind = ANY(${next(f.kinds)}::text[])`);
  if (f.sentiment?.length && opts.exclude !== 'sentiment') where.push(`a.sentiment_label = ANY(${next(f.sentiment)}::text[])`);
  if (f.geo?.length && opts.exclude !== 'geo') where.push(`g.name = ANY(${next(f.geo)}::text[])`);
  if (f.entities?.length)
    where.push(`EXISTS (SELECT 1 FROM article_entities ae JOIN entities e ON e.id = ae.entity_id WHERE ae.article_id = a.id AND e.canonical_name = ANY(${next(f.entities)}::text[]))`);
  if (f.q) {
    const q = next(f.q);
    const prefix = prefixQuery(f.q);
    const prefixSql = prefix ? ` OR a.search_simple @@ to_tsquery('simple', ${next(prefix)})` : '';
    // морфологический поиск (русский стеммер) + префикс основы без стемминга + подстрока по заголовку и именам сущностей
    where.push(`(a.search @@ websearch_to_tsquery('russian', ${q})${prefixSql} OR a.title ILIKE '%' || ${next(escapeLike(f.q))} || '%'
      OR EXISTS (SELECT 1 FROM article_entities ae JOIN entities e ON e.id = ae.entity_id WHERE ae.article_id = a.id AND e.canonical_name ILIKE '%' || ${next(escapeLike(f.q))} || '%'))`);
  }
  const scopeTopics = auth.scope.topics ?? [];
  if (scopeTopics.length) where.push(`t.key = ANY(${next(scopeTopics)}::text[])`);
  return { sql: where.join(' AND '), params };
}

export interface PolicyResolver {
  policyFor(source: { id: string; kind: SourceKind; content_policy: ContentPolicy | null }): ContentPolicy;
  excerptMax: number;
}

/**
 * Политика контента источника (PLAN §2.1, п. 5), по убыванию приоритета:
 * переопределение на уровне источника › переопределение тенанта › явная политика источника › значение по умолчанию для типа.
 */
export async function loadPolicyResolver(q: Queryable, tenantId: string): Promise<PolicyResolver> {
  const rows = await loadSettingRows(q);
  const kinds = Object.keys(SOURCE_KINDS) as SourceKind[];
  const defaults = Object.fromEntries(kinds.map((k) => [k, resolveSetting(requireDefinition(`content.policy.default.${k}`), rows.filter((r) => r.key === `content.policy.default.${k}`), { tenantId }).value as ContentPolicy]));
  const overrideDef = requireDefinition('content.policy.override');
  const overrideRows = rows.filter((r) => r.key === 'content.policy.override');
  const tenantOverride = resolveSetting(overrideDef, overrideRows, { tenantId }).value as ContentPolicy | null;
  const excerptMax = resolveSetting(requireDefinition('content.excerpt.maxChars'), rows.filter((r) => r.key === 'content.excerpt.maxChars'), { tenantId }).value as number;
  return {
    excerptMax,
    policyFor: (s) => {
      const perSource = resolveSetting(overrideDef, overrideRows, { tenantId, sourceId: s.id });
      if (perSource.from === 'source') return perSource.value as ContentPolicy;
      return tenantOverride ?? s.content_policy ?? defaults[s.kind]!;
    },
  };
}

export const truncate = (s: string | null, max: number): string | null => {
  if (!s) return s;
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), Math.floor(max * 0.6))).replace(/[\s,.;:—-]+$/, '') + '…';
};

export interface ArticleRow {
  id: string; title: string; lead: string | null; url: string; published_at: Date; sentiment_label: keyof typeof SENTIMENTS | null;
  sentiment_score: number | null; views: number; source_id: string; source_name: string; source_domain: string; source_kind: SourceKind;
  source_trust: number; source_policy: ContentPolicy | null; topic_key: string | null; topic_name: string | null; topic_color: string | null; geo_name: string | null;
}

export const ARTICLE_COLUMNS = `a.id, a.title, a.lead, a.url, a.published_at, a.sentiment_label, a.sentiment_score, a.views, a.source_id,
  s.name AS source_name, s.domain AS source_domain, s.kind AS source_kind, s.trust_score AS source_trust, s.content_policy AS source_policy,
  t.key AS topic_key, t.name AS topic_name, t.color AS topic_color, g.name AS geo_name`;

export function articleDto(row: ArticleRow, pr: PolicyResolver, entities: { persons: string[]; orgs: string[] } = { persons: [], orgs: [] }) {
  const policy = pr.policyFor({ id: row.source_id, kind: row.source_kind, content_policy: row.source_policy });
  return {
    id: row.id,
    title: row.title,
    lead: policy === 'metadata' ? null : truncate(row.lead, pr.excerptMax),
    url: row.url,
    publishedAt: row.published_at,
    sentiment: row.sentiment_label ? { label: row.sentiment_label, score: row.sentiment_score } : null,
    views: row.views,
    source: { id: row.source_id, name: row.source_name, domain: row.source_domain, kind: row.source_kind, trust: row.source_trust },
    topic: row.topic_key ? { key: row.topic_key, name: row.topic_name, color: row.topic_color } : null,
    geo: row.geo_name,
    persons: entities.persons,
    orgs: entities.orgs,
    policy,
  };
}

export async function entitiesFor(q: Queryable, articleIds: string[]): Promise<Map<string, { persons: string[]; orgs: string[] }>> {
  const map = new Map<string, { persons: string[]; orgs: string[] }>();
  if (!articleIds.length) return map;
  const r = await q.query<{ article_id: string; type: string; canonical_name: string }>(
    `SELECT ae.article_id, e.type, e.canonical_name FROM article_entities ae JOIN entities e ON e.id = ae.entity_id WHERE ae.article_id = ANY($1) ORDER BY ae.mentions DESC`, [articleIds]);
  for (const row of r.rows) {
    const e = map.get(row.article_id) ?? map.set(row.article_id, { persons: [], orgs: [] }).get(row.article_id)!;
    (row.type === 'person' ? e.persons : e.orgs).push(row.canonical_name);
  }
  return map;
}

/** Часовой пояс тенанта из профиля региона; при некорректном значении — Москва. */
export const tenantTz = (auth: AuthContext): string => {
  const tz = (auth.tenant?.regionProfile as { timezone?: string } | undefined)?.timezone;
  return tz && /^[A-Za-z_]+\/[A-Za-z_+\-0-9]+$/.test(tz) ? tz : 'Europe/Moscow';
};
