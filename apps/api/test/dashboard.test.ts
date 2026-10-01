import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client} from './helpers';
import { createTestApp, loginAs, tenantIds, withAdmin, type TestCtx } from './helpers';

let ctx: TestCtx;
let owner: Client;
let tenants: { A: string; B: string };
beforeAll(async () => {
  ctx = await createTestApp();
  owner = await loginAs(ctx, 'a.prokhorov@altai.media');
  tenants = await tenantIds();
});
afterAll(() => ctx.close());

interface Dash {
  kpis: Array<{ key: string; value: number; delta: number | null; spark: number[] | null }>;
  sentiment: { total: number; items: Array<{ key: string; count: number; share: number }> };
  volume: { labels: string[]; series: Array<{ key: string; data: number[] }> };
  topSources: Array<{ name: string; count: number }>;
  geo: { places: Array<{ name: string; count: number }>; total: number };
  persons: { top: Array<{ name: string; count: number }>; total: number };
  health: { parsers: Array<{ parser: string; sources: number; errors: number }>; sources: { active: number; errors: number; paused: number }; queue: { available: boolean } };
}

const inRange = (days: number) =>
  withAdmin(async (c) => (await c.query<{ n: number; neg: number; withSent: number }>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE sentiment_label IN ('NG','VN'))::int AS neg, count(*) FILTER (WHERE sentiment_label IS NOT NULL)::int AS "withSent"
       FROM articles a WHERE a.status = 'published' AND a.published_at >= now() - make_interval(days => $1)
        AND ((a.visibility_tenant_id IS NULL AND a.source_id IN (SELECT source_id FROM tenant_sources WHERE tenant_id = $2 AND enabled)) OR a.visibility_tenant_id = $2)`, [days, tenants.A])).rows[0]!);

describe('дашборд', () => {
  it('KPI и тональность совпадают с независимым подсчётом по БД', async () => {
    const d = (await owner.get('/v1/dashboard?range=7d')).json<Dash>();
    const truth = await inRange(7);
    // допускаем расхождение в пару материалов: граница периода «сейчас» сдвигается между запросами
    expect(Math.abs(d.kpis.find((k) => k.key === 'articles')!.value - truth.n)).toBeLessThanOrEqual(2);
    expect(Math.abs(d.kpis.find((k) => k.key === 'negative')!.value - truth.neg)).toBeLessThanOrEqual(2);
    expect(Math.abs(d.sentiment.total - truth.withSent)).toBeLessThanOrEqual(2);
    expect(d.sentiment.items.map((i) => i.key)).toEqual(['VP', 'P', 'N', 'NG', 'VN']);
    expect(Math.round(d.sentiment.items.reduce((s, i) => s + i.share, 0))).toBeGreaterThanOrEqual(99);
    const sparkTotal = d.kpis.find((k) => k.key === 'articles')!.spark!.reduce((s, x) => s + x, 0);
    expect(sparkTotal).toBeGreaterThan(0);
    expect(d.kpis.find((k) => k.key === 'articles')!.spark).toHaveLength(12);
  });

  it('динамика по темам: подписи периода и суммы рядов согласованы', async () => {
    const day = (await owner.get('/v1/dashboard?range=7d')).json<Dash>();
    expect(day.volume.labels.length).toBeGreaterThanOrEqual(7);
    expect(day.volume.labels.length).toBeLessThanOrEqual(8);
    for (const s of day.volume.series) expect(s.data).toHaveLength(day.volume.labels.length);
    const seriesTotal = day.volume.series.reduce((sum, s) => sum + s.data.reduce((a, b) => a + b, 0), 0);
    expect(seriesTotal).toBeGreaterThan(0);
    expect(seriesTotal).toBeLessThanOrEqual(day.kpis.find((k) => k.key === 'articles')!.value + 2);
    const hours = (await owner.get('/v1/dashboard?range=24h')).json<Dash>();
    expect(hours.volume.labels.length).toBeGreaterThanOrEqual(24);
    expect(hours.volume.labels.length).toBeLessThanOrEqual(25);
    const longer = (await owner.get('/v1/dashboard?range=90d')).json<Dash>();
    expect(longer.kpis[0]!.value).toBeGreaterThan(day.kpis[0]!.value);
  });

  it('топ источников, география, персоны и состояние парсеров', async () => {
    const d = (await owner.get('/v1/dashboard?range=90d')).json<Dash>();
    expect(d.topSources.length).toBeGreaterThan(0);
    expect(d.topSources.length).toBeLessThanOrEqual(8);
    const counts = d.topSources.map((s) => s.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    expect(d.geo.places[0]!.name).toBe('Барнаул');
    expect(d.persons.top.length).toBeGreaterThan(0);
    expect(d.persons.top.length).toBeLessThanOrEqual(7);
    // состояние парсеров согласовано с реестром источников (число может расти, если другие тесты добавили приватные источники)
    const registry = (await owner.get('/v1/sources')).json<{ items: Array<{ enabled: boolean; status: string }> }>().items.filter((s) => s.enabled);
    expect(d.health.parsers.reduce((s, p) => s + p.sources, 0)).toBe(registry.length);
    expect(d.health.sources.errors).toBe(registry.filter((s) => s.status === 'error').length);
    expect(d.health.sources.errors).toBeGreaterThanOrEqual(1); // biysk22.ru в демо-данных — с ошибкой
    expect(d.health.sources.paused).toBeGreaterThanOrEqual(1);
    expect(typeof d.health.queue.available).toBe('boolean');
  });

  it('данные другого тенанта и недоступные темы не попадают в дашборд', async () => {
    const maria = await loginAs(ctx, 'm.kovaleva@altai.media');
    await maria.post('/v1/auth/switch-tenant', { tenantId: tenants.B });
    const d = (await maria.get('/v1/dashboard?range=90d')).json<Dash>();
    expect(d.health.parsers.reduce((s, p) => s + p.sources, 0)).toBe(6); // 3 своих источника + 2 общих + 1 приватный
    expect(d.topSources.every((s) => !/Катунь|Банкфакт/.test(s.name))).toBe(true);
    const irina = await loginAs(ctx, 'i.lapteva@agro22.ru');
    const di = (await irina.get('/v1/dashboard?range=90d')).json<Dash>();
    expect(di.volume.series.map((s) => s.key).sort()).toEqual(['agro', 'food']);
  });

  it('параметр периода проверяется', async () => {
    expect((await owner.get('/v1/dashboard?range=forever')).statusCode).toBe(422);
  });
});

describe('аналитика', () => {
  interface Overview {
    kpis: { articles: number; avgSentiment: number | null; uniquePersons: number; critical: number };
    sentimentIndex: Array<{ date: string; score: number; average: number }>;
    sourceComparison: Array<{ id: string; count: number; negativeShare: number; trust: number }>;
    heatmap: { rows: Array<{ key: string }>; cols: Array<{ id: string }>; cells: Array<{ topic: string; sourceId: string; count: number }> };
    hours: number[];
    words: Array<{ word: string; count: number }>;
    insights: Array<{ kind: string; title: string; text: string }>;
  }

  it('сводка: показатели, индекс тональности, сравнение источников, часы, облако слов', async () => {
    const a = (await owner.get('/v1/analytics/overview?range=30d')).json<Overview>();
    expect(a.kpis.articles).toBeGreaterThan(100);
    expect(a.kpis.avgSentiment).toBeGreaterThan(-1);
    expect(a.kpis.avgSentiment).toBeLessThan(1);
    expect(a.kpis.uniquePersons).toBeGreaterThan(0);
    expect(a.sentimentIndex.length).toBeGreaterThan(10);
    for (const p of a.sentimentIndex) { expect(p.score).toBeGreaterThanOrEqual(-1); expect(p.score).toBeLessThanOrEqual(1); expect(p.average).toBeGreaterThanOrEqual(-1); }
    expect(a.sourceComparison.length).toBeGreaterThan(3);
    for (const s of a.sourceComparison) { expect(s.negativeShare).toBeGreaterThanOrEqual(0); expect(s.negativeShare).toBeLessThanOrEqual(100); }
    expect(a.hours).toHaveLength(24);
    expect(a.hours.reduce((s, x) => s + x, 0)).toBe(a.kpis.articles);
    // рабочие часы по Барнаулу (UTC+7) активнее ночных
    expect(a.hours.slice(8, 15).reduce((s, x) => s + x, 0)).toBeGreaterThan(a.hours.slice(0, 5).reduce((s, x) => s + x, 0));
    expect(a.words.length).toBeGreaterThan(10);
    expect(a.words.every((w) => w.word.length >= 4)).toBe(true);
    const counts = a.words.map((w) => w.count);
    expect([...counts].sort((x, y) => y - x)).toEqual(counts);
  });

  it('тепловая карта и наблюдения построены по данным', async () => {
    const a = (await owner.get('/v1/analytics/overview?range=30d')).json<Overview>();
    expect(a.heatmap.rows.length).toBeGreaterThanOrEqual(7);
    expect(a.heatmap.cols.length).toBeLessThanOrEqual(9);
    const colIds = new Set(a.heatmap.cols.map((c) => c.id));
    expect(a.heatmap.cells.every((c) => colIds.has(c.sourceId) && c.count > 0)).toBe(true);
    expect(a.insights.length).toBeGreaterThan(0);
    for (const i of a.insights) { expect(i.title.length).toBeGreaterThan(5); expect(i.text).toMatch(/\d/); }
  });
});
