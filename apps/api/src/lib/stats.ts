import { SENTIMENT_KEYS, SENTIMENTS, type SentimentLabel } from '@mediaradar/core';
import type { Queryable } from '@mediaradar/db';
import { ARTICLE_FROM, buildArticleWhere, type ArticleFilter } from './content';
import type { AuthContext } from '../plugins/auth';

/** Основы слов, которые не говорят о теме: названия месяцев, регион и страна (они есть почти в каждом заголовке). */
const STOPSTEMS = new Set(
  'январ февра марта апрел мая июня июля авгус сентя октяб ноябр декаб алтай росси крае'.split(' '),
);
const STOPWORDS = new Set(
  'который которая которое которые также после перед между более менее этого этой этих этот эта или как для при над под про его ещё еще был была были будет будут может могут чтобы если когда только очень всех всем свои своих свой края краю краем регион региона регионе регионы'.split(
    ' ',
  ),
);

/** Область выборки: фильтр ленты плюс условие (`tail`), параметры которого всегда нумеруются с {1}: сдвиг делает этот файл. */
export interface Scope {
  filter?: Partial<ArticleFilter>;
  tail?: string;
  extra?: unknown[];
}

/**
 * Запрос по материалам за период. extra-параметры нумеруются после параметров фильтра:
 * и в select, и в tail их нужно адресовать как {n}.
 */
export async function periodQuery<T extends Record<string, unknown>>(
  q: Queryable,
  a: AuthContext,
  from: Date,
  to: Date,
  select: string,
  tail: string,
  extra: unknown[] = [],
  filter: Partial<ArticleFilter> = {},
): Promise<T[]> {
  const w = buildArticleWhere({ ...filter, from, to }, a);
  const bind = (sql: string) =>
    sql.replace(/\{(\d+)\}/g, (_, i: string) => `$${w.params.length + Number(i)}`);
  return (
    await q.query<T>(`SELECT ${bind(select)} ${ARTICLE_FROM} WHERE ${w.sql} ${bind(tail)}`, [
      ...w.params,
      ...extra,
    ])
  ).rows;
}

/** Сдвигает номера {n} в условии области на число собственных параметров запроса. */
const shift = (sql: string | undefined, by: number) =>
  (sql ?? '').replace(/\{(\d+)\}/g, (_, i: string) => `{${Number(i) + by}}`);

/** Самые частые слова заголовков: словоформы с общей основой из 5 букв считаются одним словом. */
export function topWords(titles: string[], limit = 24): Array<{ word: string; count: number }> {
  const groups = new Map<string, Map<string, number>>();
  for (const title of titles)
    for (const w of title.toLowerCase().match(/[а-яёa-z]{4,}/g) ?? []) {
      const stem = w.slice(0, 5);
      if (STOPWORDS.has(w) || STOPSTEMS.has(stem)) continue;
      const g = groups.get(stem) ?? groups.set(stem, new Map()).get(stem)!;
      g.set(w, (g.get(w) ?? 0) + 1);
    }
  return [...groups.values()]
    .map((g) => ({
      word: [...g].sort((x, y) => y[1] - x[1])[0]![0],
      count: [...g.values()].reduce((s, x) => s + x, 0),
    }))
    .sort((x, y) => y.count - x.count)
    .slice(0, limit);
}

/** Условие «в материале упомянута сущность» для Scope.tail; идентификатор сущности — первый параметр области. */
export const MENTIONS_ENTITY =
  'AND EXISTS (SELECT 1 FROM article_entities ae WHERE ae.article_id = a.id AND ae.entity_id = {1}::uuid)';

/** Публикации по суткам (часовой пояс тенанта), без пропусков. */
export async function dailySeries(
  q: Queryable,
  a: AuthContext,
  from: Date,
  to: Date,
  tz: string,
  scope: Scope = {},
): Promise<Array<{ date: string; count: number }>> {
  const labels = (
    await q.query<{ d: string }>(
      `SELECT to_char(b, 'YYYY-MM-DD') AS d FROM generate_series(date_trunc('day', $1::timestamptz AT TIME ZONE $3), date_trunc('day', $2::timestamptz AT TIME ZONE $3), '1 day'::interval) AS b ORDER BY b`,
      [from, to, tz],
    )
  ).rows.map((x) => x.d);
  const rows = await periodQuery<{ d: string; n: number }>(
    q,
    a,
    from,
    to,
    "to_char(date_trunc('day', a.published_at AT TIME ZONE {1}), 'YYYY-MM-DD') AS d, count(*)::int AS n",
    `${shift(scope.tail, 1)} GROUP BY 1`,
    [tz, ...(scope.extra ?? [])],
    scope.filter,
  );
  const byDay = new Map(rows.map((x) => [x.d, x.n]));
  return labels.map((date) => ({ date, count: byDay.get(date) ?? 0 }));
}

/** Распределения для профиля: активность по часам суток, тональность, темы, источники, слова заголовков. */
export async function breakdowns(
  q: Queryable,
  a: AuthContext,
  from: Date,
  to: Date,
  tz: string,
  scope: Scope = {},
) {
  const run = <T extends Record<string, unknown>>(select: string, rest: string) =>
    periodQuery<T>(
      q,
      a,
      from,
      to,
      select,
      `${shift(scope.tail, 0)} ${rest}`,
      scope.extra ?? [],
      scope.filter,
    );
  // собственный параметр {1} — часовой пояс, параметры области идут за ним
  const withTz = <T extends Record<string, unknown>>(select: string, rest: string) =>
    periodQuery<T>(
      q,
      a,
      from,
      to,
      select,
      `${shift(scope.tail, 1)} ${rest}`,
      [tz, ...(scope.extra ?? [])],
      scope.filter,
    );

  const hourRows = await withTz<{ h: number; n: number }>(
    'extract(hour FROM a.published_at AT TIME ZONE {1})::int AS h, count(*)::int AS n',
    'GROUP BY 1',
  );
  const hours = Array.from({ length: 24 }, (_, h) => hourRows.find((x) => x.h === h)?.n ?? 0);

  const sentRows = await run<{ label: SentimentLabel; n: number; avg: number | null }>(
    'a.sentiment_label AS label, count(*)::int AS n, avg(a.sentiment_score)::float AS avg',
    'AND a.sentiment_label IS NOT NULL GROUP BY 1',
  );
  const sentTotal = sentRows.reduce((s, x) => s + x.n, 0);
  const avgScore = sentTotal ? sentRows.reduce((s, x) => s + (x.avg ?? 0) * x.n, 0) / sentTotal : null;
  const sentiment = SENTIMENT_KEYS.map((key) => {
    const count = sentRows.find((x) => x.label === key)?.n ?? 0;
    return {
      key,
      label: SENTIMENTS[key].label,
      short: SENTIMENTS[key].short,
      color: SENTIMENTS[key].hex,
      count,
      share: sentTotal ? Math.round((count / sentTotal) * 1000) / 10 : 0,
    };
  });

  const topics = await run<{ key: string; name: string; color: string; count: number }>(
    't.key, t.name, t.color, count(*)::int AS count',
    'AND t.key IS NOT NULL GROUP BY t.key, t.name, t.color ORDER BY count DESC LIMIT 8',
  );
  const sources = await run<{ id: string; name: string; domain: string; count: number }>(
    's.id, s.name, s.domain, count(*)::int AS count',
    'GROUP BY s.id, s.name, s.domain ORDER BY count DESC LIMIT 8',
  );
  const titles = await run<{ title: string }>('a.title', 'ORDER BY a.published_at DESC LIMIT 4000');

  return {
    hours,
    sentiment: {
      total: sentTotal,
      avgScore: avgScore === null ? null : Math.round(avgScore * 1000) / 1000,
      items: sentiment,
    },
    topics,
    sources,
    words: topWords(
      titles.map((t) => t.title),
      20,
    ),
  };
}
