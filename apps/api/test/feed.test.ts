import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from './helpers';
import { createTestApp, loginAs, tenantIds, withAdmin, type TestCtx } from './helpers';

let ctx: TestCtx;
let owner: Client; // OWNER тенанта «Алтайский край»
let tenants: { A: string; B: string };
beforeAll(async () => {
  ctx = await createTestApp();
  owner = await loginAs(ctx, 'a.prokhorov@altai.media');
  tenants = await tenantIds();
});
afterAll(() => ctx.close());

/** Независимый подсчёт видимых тенанту материалов напрямую в БД (от имени владельца БД, без RLS). */
const countVisible = (tenantId: string, extraWhere = '', params: unknown[] = []) =>
  withAdmin(
    async (c) =>
      (
        await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN topics t ON t.id = a.topic_id LEFT JOIN geo_places g ON g.id = a.geo_id
      WHERE a.status = 'published' AND ((a.visibility_tenant_id IS NULL AND a.source_id IN (SELECT source_id FROM tenant_sources WHERE tenant_id = $1 AND enabled)) OR a.visibility_tenant_id = $1) ${extraWhere}`,
          [tenantId, ...params],
        )
      ).rows[0]!.n,
  );

interface Item {
  id: string;
  title: string;
  lead: string | null;
  publishedAt: string;
  sentiment: { label: string; score: number } | null;
  source: { id: string; name: string; kind: string };
  topic: { key: string } | null;
  persons: string[];
  policy: string;
}
interface Page {
  items: Item[];
  total: number;
  nextCursor: string | null;
  nextOffset: number | null;
}
const list = async (c: Client, qs = ''): Promise<Page> => (await c.get(`/v1/articles?${qs}`)).json();

describe('лента: список и пагинация', () => {
  it('возвращает карточки с источником, темой, тональностью; total совпадает с независимым подсчётом', async () => {
    const page = await list(owner, 'limit=12');
    expect(page.items).toHaveLength(12);
    expect(page.total).toBe(await countVisible(tenants.A));
    for (const it of page.items) {
      expect(it.title).toBeTruthy();
      expect(it.source.name).toBeTruthy();
      expect(['VP', 'P', 'N', 'NG', 'VN']).toContain(it.sentiment!.label);
    }
    const times = page.items.map((i) => Date.parse(i.publishedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('курсорная пагинация: страницы не пересекаются и покрывают весь результат', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Page = await list(owner, `limit=50${cursor ? `&cursor=${cursor}` : ''}`);
      for (const it of page.items) {
        expect(seen.has(it.id), `дубль ${it.id}`).toBe(false);
        seen.add(it.id);
      }
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 60);
    expect(seen.size).toBe(await countVisible(tenants.A));
  });

  it('сортировка «старые сначала» и по тональности; смещение для некурсорных сортировок', async () => {
    const old = await list(owner, 'sort=old&limit=20');
    const t = old.items.map((i) => Date.parse(i.publishedAt));
    expect([...t].sort((a, b) => a - b)).toEqual(t);
    const sent = await list(owner, 'sort=sent&limit=15');
    const scores = sent.items.map((i) => i.sentiment!.score);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
    expect(sent.nextOffset).toBe(15);
    const page2 = await list(owner, `sort=sent&limit=15&offset=${sent.nextOffset}`);
    expect(page2.items.some((i) => sent.items.some((x) => x.id === i.id))).toBe(false);
    const src = await list(owner, 'sort=src&limit=50');
    const names = src.items.map((i) => i.source.name);
    const closed = new Set<string>();
    names.forEach((n, i) => {
      if (i && n !== names[i - 1]) closed.add(names[i - 1]!);
      expect(closed.has(n), `источник «${n}» разорван`).toBe(false);
    });
  });

  it('некорректные параметры отклоняются', async () => {
    expect((await owner.get('/v1/articles?limit=1000')).statusCode).toBe(422);
    expect((await owner.get('/v1/articles?cursor=@@@')).statusCode).toBe(400);
    expect((await owner.get('/v1/articles?sort=hack')).statusCode).toBe(422);
    expect((await owner.get('/v1/articles?sources=not-a-uuid')).statusCode).toBe(400); // некорректный uuid → ошибка данных, не 500
  });
});

describe('лента: фильтры, поиск, фасеты', () => {
  it('фильтры по тональности, теме, типу источника и их комбинация совпадают с независимым подсчётом', async () => {
    const neg = await list(owner, 'sentiment=NG,VN&limit=50');
    expect(neg.items.every((i) => ['NG', 'VN'].includes(i.sentiment!.label))).toBe(true);
    expect(neg.total).toBe(await countVisible(tenants.A, "AND a.sentiment_label IN ('NG','VN')"));
    const fuel = await list(owner, 'topics=fuel&limit=50');
    expect(fuel.items.every((i) => i.topic?.key === 'fuel')).toBe(true);
    const combo = await list(owner, 'topics=fuel&sentiment=NG,VN&kinds=NEWS_SITE,GOV_PORTAL');
    expect(combo.total).toBe(
      await countVisible(
        tenants.A,
        "AND t.key = 'fuel' AND a.sentiment_label IN ('NG','VN') AND s.kind IN ('NEWS_SITE','GOV_PORTAL')",
      ),
    );
    const tg = await list(owner, 'kinds=TELEGRAM&limit=50');
    expect(tg.items.every((i) => i.source.kind === 'TELEGRAM')).toBe(true);
    const range = await list(owner, `from=${new Date(Date.now() - 3 * 864e5).toISOString()}&limit=50`);
    expect(range.items.every((i) => Date.parse(i.publishedAt) >= Date.now() - 3 * 864e5 - 1000)).toBe(true);
  });

  it('поиск учитывает морфологию, ищет по сущностям и экранирует спецсимволы', async () => {
    // разные словоформы одного слова (стеммер Snowball сам их не объединяет — см. миграцию 0006)
    const forms = await Promise.all(
      ['урожай', 'урожая', 'урожаю', 'урожае'].map((w) => list(owner, `q=${encodeURIComponent(w)}&limit=50`)),
    );
    for (const [i, page] of forms.entries()) {
      expect(page.total, `форма №${i}`).toBeGreaterThan(0);
      expect(page.items.every((x) => /урожа|урож/i.test(x.title + (x.lead ?? '')))).toBe(true);
    }
    expect(new Set(forms.map((p) => p.total)).size).toBe(1); // все формы дают один и тот же результат
    const city = await list(owner, `q=${encodeURIComponent('Барнауле')}&limit=50`);
    expect(city.total).toBeGreaterThan(0);
    const person = await list(owner, `q=${encodeURIComponent('Соколов')}&limit=50`);
    expect(person.total).toBeGreaterThan(0);
    expect(
      person.items.every((i) => i.persons.some((p) => /Соколов/.test(p)) || /Соколов/.test(i.title)),
    ).toBe(true);
    const all = await list(owner, 'limit=1');
    const percent = await list(owner, `q=${encodeURIComponent('%')}&limit=50`);
    expect(percent.total).toBeLessThan(all.total);
    expect(percent.items.every((i) => i.title.includes('%'))).toBe(true);
    const sqli = await owner.get(`/v1/articles?q=${encodeURIComponent("'; DROP TABLE articles; --")}`);
    expect(sqli.statusCode).toBe(200);
    expect((await list(owner, 'limit=1')).total).toBe(all.total);
  });

  it('фасеты: счётчики согласованы с результатом; фасет не учитывает собственный фильтр', async () => {
    const f = (await owner.get('/v1/articles/facets')).json();
    const totalAll = (await list(owner, 'limit=1')).total;
    expect(f.sentiment.reduce((s: number, x: { count: number }) => s + x.count, 0)).toBe(totalAll);
    expect(f.kinds.reduce((s: number, x: { count: number }) => s + x.count, 0)).toBe(totalAll);
    expect(f.topics.length).toBeGreaterThanOrEqual(7);
    const withFuel = (await owner.get('/v1/articles/facets?topics=fuel')).json();
    const fuelTotal = (await list(owner, 'topics=fuel&limit=1')).total;
    expect(withFuel.sentiment.reduce((s: number, x: { count: number }) => s + x.count, 0)).toBe(fuelTotal); // другие фасеты сужены
    expect(withFuel.topics.find((t: { key: string }) => t.key === 'agro').count).toBeGreaterThan(0); // собственный — нет
  });
});

describe('политика контента', () => {
  const firstOf = async (kinds: string) => (await list(owner, `kinds=${kinds}&limit=1`)).items[0]!;
  const detail = async (c: Client, id: string) => (await c.get(`/v1/articles/${id}`)).json();

  it('по умолчанию: гос. портал — полный текст; СМИ и Telegram — только лид, без тела', async () => {
    const gov = await detail(owner, (await firstOf('GOV_PORTAL')).id);
    expect(gov.policy).toBe('full');
    expect(gov.body.length).toBeGreaterThan(100);
    for (const kind of ['NEWS_SITE', 'TELEGRAM']) {
      const d = await detail(owner, (await firstOf(kind)).id);
      expect(d.policy, kind).toBe('excerpt');
      expect(d.body, kind).toBeNull();
      expect(d.lead.length).toBeLessThanOrEqual(401);
      expect(d.url).toMatch(/^https:\/\//); // ссылка на оригинал
    }
  });

  it('настройки тенанта меняют выдачу: metadata убирает лид и тело, maxChars усекает лид; сброс возвращает умолчание', async () => {
    const id = (await firstOf('GOV_PORTAL')).id;
    const put = (key: string, value: unknown) =>
      owner.put(`/v1/settings/${key}`, { scope: 'tenant', scopeId: tenants.A, value });
    try {
      expect((await put('content.policy.override', 'metadata')).statusCode).toBe(200);
      const d = await detail(owner, id);
      expect(d.policy).toBe('metadata');
      expect(d.body).toBeNull();
      expect(d.lead).toBeNull();
      expect(
        (await list(owner, 'limit=5')).items.every((i) => i.lead === null && i.policy === 'metadata'),
      ).toBe(true);
      expect(
        (await owner.delete(`/v1/settings/content.policy.override?scope=tenant&scopeId=${tenants.A}`))
          .statusCode,
      ).toBe(200);
      expect((await detail(owner, id)).policy).toBe('full');
      expect((await put('content.excerpt.maxChars', 100)).statusCode).toBe(200);
      const news = await detail(owner, (await firstOf('NEWS_SITE')).id);
      expect(news.lead.length).toBeLessThanOrEqual(101);
    } finally {
      await owner.delete(`/v1/settings/content.policy.override?scope=tenant&scopeId=${tenants.A}`);
      await owner.delete(`/v1/settings/content.excerpt.maxChars?scope=tenant&scopeId=${tenants.A}`);
    }
  });
});

describe('ограничение области доступа (ABAC) и изоляция тенантов', () => {
  it('пользователь с областью «агро, пищепром» видит только эти темы', async () => {
    const irina = await loginAs(ctx, 'i.lapteva@agro22.ru');
    const page = await list(irina, 'limit=50');
    expect(page.total).toBe(await countVisible(tenants.A, "AND t.key IN ('agro','food')"));
    expect(page.items.every((i) => ['agro', 'food'].includes(i.topic!.key))).toBe(true);
    // попытка запросить другую тему не расширяет доступ
    expect((await list(irina, 'topics=gov&limit=50')).total).toBe(0);
    // материал вне области — 404
    const gov = (await list(owner, 'topics=gov&limit=1')).items[0]!;
    expect((await irina.get(`/v1/articles/${gov.id}`)).statusCode).toBe(404);
    const facets = (await irina.get('/v1/articles/facets')).json();
    expect(
      facets.topics
        .filter((t: { count: number }) => t.count > 0)
        .map((t: { key: string }) => t.key)
        .sort(),
    ).toEqual(['agro', 'food']);
  });

  it('тенант видит только свои источники и материалы; чужие материалы по ID — 404', async () => {
    const maria = await loginAs(ctx, 'm.kovaleva@altai.media');
    await maria.post('/v1/auth/switch-tenant', { tenantId: tenants.B });
    const pageB = await list(maria, 'limit=50');
    expect(pageB.total).toBe(await countVisible(tenants.B));
    const allowed = await withAdmin(
      async (c) =>
        new Set(
          (
            await c.query<{ source_id: string }>(
              'SELECT source_id FROM tenant_sources WHERE tenant_id = $1',
              [tenants.B],
            )
          ).rows.map((r) => r.source_id),
        ),
    );
    const privateSource = await withAdmin(
      async (c) =>
        (await c.query<{ id: string }>('SELECT id FROM sources WHERE owner_tenant_id = $1', [tenants.B]))
          .rows[0]!.id,
    );
    for (const it of pageB.items)
      expect(allowed.has(it.source.id) || it.source.id === privateSource).toBe(true);
    const aOnly = (await list(owner, 'kinds=NEWS_SITE&limit=50')).items.find(
      (i) => !allowed.has(i.source.id),
    )!;
    expect((await maria.get(`/v1/articles/${aOnly.id}`)).statusCode).toBe(404);
  });

  it('приватные материалы тенанта B видны ему и недоступны тенанту A', async () => {
    const ownerB = await loginAs(ctx, 'owner@altai-republic.demo');
    const privSrc = await withAdmin(
      async (c) =>
        (await c.query<{ id: string }>('SELECT id FROM sources WHERE owner_tenant_id = $1', [tenants.B]))
          .rows[0]!.id,
    );
    const b = await list(ownerB, `sources=${privSrc}&limit=50`);
    expect(b.total).toBeGreaterThan(0);
    const a = await list(owner, `sources=${privSrc}&limit=50`);
    expect(a.total).toBe(0);
    expect((await owner.get(`/v1/articles/${b.items[0]!.id}`)).statusCode).toBe(404);
  });
});

describe('сохранённые фильтры', () => {
  it('личные и командные; команду создаёт только тот, у кого есть право; удалять можно свои', async () => {
    const viewer = await loginAs(ctx, 'i.lapteva@agro22.ru');
    const analyst = await loginAs(ctx, 'm.kovaleva@altai.media');
    const moderator = await loginAs(ctx, 'o.timoshina@altai.media');
    const filter = { topics: ['fuel'], sentiment: ['NG'] };
    expect((await viewer.post('/v1/saved-filters', { name: 'Личный (тест)', filter })).statusCode).toBe(201);
    expect(
      (await viewer.post('/v1/saved-filters', { name: 'Командный (тест)', filter, visibility: 'team' }))
        .statusCode,
    ).toBe(403);
    const team = await analyst.post('/v1/saved-filters', {
      name: 'Командный (тест)',
      filter,
      visibility: 'team',
    });
    expect(team.statusCode).toBe(201);
    const seen = (await moderator.get('/v1/saved-filters')).json().items.map((x: { name: string }) => x.name);
    expect(seen).toContain('Командный (тест)');
    expect(seen).not.toContain('Личный (тест)');
    expect((await moderator.delete(`/v1/saved-filters/${team.json().id}`)).statusCode).toBe(404); // чужой
    expect((await analyst.delete(`/v1/saved-filters/${team.json().id}`)).statusCode).toBe(200);
  });
});

describe('prefixQuery', () => {
  it('строит безопасный запрос: только буквы и цифры, окончания отбрасываются', async () => {
    const { prefixQuery } = await import('../src/lib/content');
    expect(prefixQuery('урожаю')).toBe('урожа:*');
    expect(prefixQuery('Барнауле')).toBe('барнау:*');
    expect(prefixQuery('ЖКХ дороги')).toBe('жкх:* & дорог:*');
    expect(prefixQuery("a'b | & ! ( ) :*")).toBe(null);
    expect(prefixQuery('')).toBe(null);
    expect(prefixQuery("рост'); DROP TABLE x;--")).toBe('рос:* & dro:* & tabl:*');
  });
});
