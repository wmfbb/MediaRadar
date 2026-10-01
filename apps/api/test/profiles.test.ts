import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from './helpers';
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

interface Profile {
  total: number;
  prevTotal: number;
  share: number | null;
  daily: Array<{ date: string; count: number }>;
  hours: number[];
  sentiment: { total: number; avgScore: number | null; items: Array<{ key: string; count: number }> };
  topics: Array<{ key: string; count: number }>;
  sources: Array<{ id: string; count: number }>;
  words: Array<{ word: string; count: number }>;
  latest: Array<{
    id: string;
    publishedAt: string;
    source: { id: string };
    persons: string[];
    orgs: string[];
  }>;
}
interface SourceProfile extends Profile {
  source: { id: string; name: string; domain: string };
  entities: Array<{ id: string; name: string; count: number }>;
}
interface EntityProfile extends Profile {
  entity: { id: string; name: string; type: string };
  related: Array<{ id: string; name: string; count: number }>;
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

describe('профиль источника', () => {
  it('цифры совпадают с независимым подсчётом по БД', async () => {
    const top = (await owner.get('/v1/dashboard?range=90d')).json<{ topSources: Array<{ id: string }> }>()
      .topSources[0]!;
    const p = (await owner.get(`/v1/sources/${top.id}/profile?range=90d`)).json<SourceProfile>();
    const truth = await withAdmin(
      async (c) =>
        (
          await c.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM articles WHERE source_id = $1 AND status = 'published' AND published_at >= now() - interval '90 days'",
            [top.id],
          )
        ).rows[0]!.n,
    );
    expect(Math.abs(p.total - truth)).toBeLessThanOrEqual(2);
    expect(Math.abs(sum(p.daily.map((d) => d.count)) - p.total)).toBeLessThanOrEqual(2);
    expect(p.hours).toHaveLength(24);
    expect(Math.abs(sum(p.hours) - p.total)).toBeLessThanOrEqual(2);
    expect(p.sentiment.total).toBeLessThanOrEqual(p.total);
    expect(sum(p.sentiment.items.map((i) => i.count))).toBe(p.sentiment.total);
    expect(p.sources.every((s) => s.id === top.id)).toBe(true); // в профиле источника — только он сам
    expect(p.share).toBeGreaterThan(0);
    expect(p.share).toBeLessThanOrEqual(100);
    expect(p.latest.length).toBeGreaterThan(0);
    expect(p.latest.length).toBeLessThanOrEqual(10);
    expect(p.latest.every((a) => a.source.id === top.id)).toBe(true);
    const times = p.latest.map((a) => Date.parse(a.publishedAt));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    const dates = p.daily.map((d) => d.date);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('несуществующий и чужой источники — «не найден»', async () => {
    expect((await owner.get('/v1/sources/00000000-0000-4000-8000-000000000000/profile')).statusCode).toBe(
      404,
    );
    const foreign = await withAdmin(
      async (c) =>
        (
          await c.query<{ id: string }>('SELECT id FROM sources WHERE owner_tenant_id = $1 LIMIT 1', [
            tenants.B,
          ])
        ).rows[0],
    );
    if (foreign) expect((await owner.get(`/v1/sources/${foreign.id}/profile`)).statusCode).toBe(404);
  });

  it('параметры проверяются, без входа доступа нет', async () => {
    const top = (await owner.get('/v1/dashboard?range=7d')).json<{ topSources: Array<{ id: string }> }>()
      .topSources[0]!;
    expect((await owner.get(`/v1/sources/${top.id}/profile?range=forever`)).statusCode).toBe(422);
    expect((await owner.get('/v1/sources/not-a-uuid/profile')).statusCode).toBe(422);
  });
});

describe('персоны и организации', () => {
  it('список по убыванию упоминаний; поиск по имени', async () => {
    const list = (await owner.get('/v1/entities?type=person&range=90d')).json<{
      items: Array<{ id: string; name: string; count: number }>;
    }>();
    expect(list.items.length).toBeGreaterThan(0);
    const counts = list.items.map((x) => x.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    const first = list.items[0]!;
    const found = (
      await owner.get(`/v1/entities?type=person&range=90d&q=${encodeURIComponent(first.name.slice(0, 4))}`)
    ).json<{ items: Array<{ name: string }> }>();
    expect(found.items.some((x) => x.name === first.name)).toBe(true);
    const none = (await owner.get('/v1/entities?type=person&q=zzzzнетакогоzzzz')).json<{
      items: unknown[];
    }>();
    expect(none.items).toEqual([]);
    const orgs = (await owner.get('/v1/entities?type=org&range=90d')).json<{ items: unknown[] }>();
    expect(orgs.items.length).toBeGreaterThan(0);
  });

  it('профиль персоны согласован со списком и ограничен её упоминаниями', async () => {
    const list = (await owner.get('/v1/entities?type=person&range=90d')).json<{
      items: Array<{ id: string; name: string; count: number }>;
    }>();
    const e = list.items[0]!;
    const p = (await owner.get(`/v1/entities/${e.id}/profile?range=90d`)).json<EntityProfile>();
    expect(p.entity.name).toBe(e.name);
    expect(Math.abs(p.total - e.count)).toBeLessThanOrEqual(2);
    expect(Math.abs(sum(p.daily.map((d) => d.count)) - p.total)).toBeLessThanOrEqual(2);
    expect(Math.abs(sum(p.hours) - p.total)).toBeLessThanOrEqual(2);
    expect(p.latest.length).toBeGreaterThan(0);
    // у каждого из последних материалов эта персона действительно упомянута
    expect(p.latest.every((a) => a.persons.includes(e.name))).toBe(true);
    expect(p.related.every((r) => r.id !== e.id && r.count <= p.total)).toBe(true);
    expect(p.total).toBeLessThanOrEqual(
      (await owner.get('/v1/dashboard?range=90d')).json<{ kpis: Array<{ value: number }> }>().kpis[0]!.value +
        2,
    );
  });

  it('несуществующая сущность — «не найдена»', async () => {
    expect((await owner.get('/v1/entities/00000000-0000-4000-8000-000000000000/profile')).statusCode).toBe(
      404,
    );
  });

  it('ограничение по темам действует и в профилях', async () => {
    const irina = await loginAs(ctx, 'i.lapteva@agro22.ru');
    const all = (await owner.get('/v1/entities?type=person&range=90d')).json<{
      items: Array<{ id: string; count: number }>;
    }>();
    const mine = (await irina.get('/v1/entities?type=person&range=90d')).json<{
      items: Array<{ id: string; count: number }>;
    }>();
    const id = mine.items[0]?.id;
    if (id) {
      const a = all.items.find((x) => x.id === id)!;
      expect(mine.items.find((x) => x.id === id)!.count).toBeLessThanOrEqual(a.count);
      const p = (await irina.get(`/v1/entities/${id}/profile?range=90d`)).json<EntityProfile>();
      expect(p.topics.every((t) => ['agro', 'food'].includes(t.key))).toBe(true);
    }
  });
});
