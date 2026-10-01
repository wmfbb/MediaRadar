import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@mediaradar/db';
import { collectSource, type CollectDeps, type SourceConfig } from '../src/collector/collect';
import type { FetchResult, Fetcher } from '../src/collector/http';
import { selectDueSources } from '../src/collector/schedule';
import { verifyArticles } from '../src/collector/verify';
import { TEST_DB } from './global-setup';

const base = process.env.TEST_PG_URL ?? 'postgres://mediaradar:mediaradar_dev@localhost:5432';
const ADMIN_URL = `${base}/${TEST_DB}`;
const WORKER_URL = `postgres://app_worker:app_worker_dev@localhost:5432/${TEST_DB}`;
const NOW = new Date('2026-10-01T06:00:00Z');
const log = { info: () => {}, warn: () => {}, error: () => {} };

let admin: pg.Client;
let db: Db;
let tenantId: string;
const created: string[] = [];

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  db = createDb(WORKER_URL, { max: 3, applicationName: 'test-collect' });
  tenantId = (await admin.query<{ id: string }>("SELECT id FROM tenants WHERE slug = 'altai-krai'")).rows[0]!
    .id;
});
afterAll(async () => {
  if (created.length) await admin.query('DELETE FROM sources WHERE id = ANY($1)', [created]);
  await admin.end();
  await db.close();
});

async function makeSource(
  domain: string,
  config: SourceConfig | null,
  parser: 'RSS' | 'CHEERIO' = 'RSS',
  cron = '*/10 * * * *',
) {
  const id = (
    await admin.query<{ id: string }>(
      `INSERT INTO sources (kind, name, url, domain, parser, cron, meta) VALUES ('NEWS_SITE', $1, $2, $1, $3, $4, '{}') RETURNING id`,
      [domain, `https://${domain}/`, parser, cron],
    )
  ).rows[0]!.id;
  created.push(id);
  if (config)
    await admin.query('INSERT INTO source_configs (source_id, version, config) VALUES ($1, 1, $2)', [
      id,
      JSON.stringify(config),
    ]);
  await admin.query('INSERT INTO tenant_sources (tenant_id, source_id) VALUES ($1, $2)', [tenantId, id]);
  return id;
}

const ok = (body: string, url: string): FetchResult => ({
  status: 200,
  url,
  redirected: false,
  contentType: 'text/html',
  body,
});
const fetcherFrom = (pages: Record<string, FetchResult | Error>) => {
  const calls: string[] = [];
  const f: Fetcher = async (url) => {
    calls.push(url);
    const r = pages[url];
    if (!r) return { status: 404, url, redirected: false, contentType: '', body: '' };
    if (r instanceof Error) throw r;
    return r;
  };
  return Object.assign(f, { calls });
};
function deps(fetch: Fetcher, published: Array<[string, unknown]> = []): CollectDeps {
  return {
    run: (fn) => db.raw(fn),
    bus: { publish: async (c, p) => void published.push([c, p]) },
    log,
    fetch,
    now: () => NOW,
    sleep: async () => {},
  };
}
const rows = async (sourceId: string) =>
  (await admin.query('SELECT * FROM articles WHERE source_id = $1 ORDER BY published_at DESC', [sourceId]))
    .rows;

const FEED = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
  <item><title>Свежая новость</title><link>https://feed.test/news/1</link><description><![CDATA[<p>Лид свежей новости</p>]]></description><pubDate>Thu, 01 Oct 2026 12:00:00 +0700</pubDate><enclosure url="https://feed.test/p.jpg" type="image/jpeg"/></item>
  <item><title>Старая новость</title><link>https://www.feed.test/news/2?utm_source=rss</link><description>Старый лид</description><pubDate>Mon, 28 Sep 2026 10:00:00 +0700</pubDate></item>
  <item><title>Дубль старой</title><link>https://feed.test/news/2/</link><description>Тот же адрес</description><pubDate>Mon, 28 Sep 2026 10:00:00 +0700</pubDate></item>
</channel></rss>`;

describe('сбор по RSS', () => {
  it('сохраняет минимум, убирает дубли, шлёт в Live только свежее и не повторяется при втором проходе', async () => {
    const id = await makeSource('feed.test', { type: 'rss', feedUrl: 'https://feed.test/rss' });
    const published: Array<[string, unknown]> = [];
    const f = fetcherFrom({ 'https://feed.test/rss': ok(FEED, 'https://feed.test/rss') });

    const first = await collectSource(deps(f, published), id);
    expect(first).toMatchObject({ fetched: 2, inserted: 2, failed: 0 });
    const r = await rows(id);
    expect(r.map((x) => x.title)).toEqual(['Свежая новость', 'Старая новость']);
    expect(r[0]).toMatchObject({
      lead: 'Лид свежей новости',
      image_url: 'https://feed.test/p.jpg',
      canonical_url: 'https://feed.test/news/1',
      source_state: 'available',
      status: 'published',
    });
    expect(r[0].id).toMatch(/^[0-9a-f-]{36}$/); // собственный ID записи
    expect(r[0].published_at.toISOString()).toBe('2026-10-01T05:00:00.000Z');
    expect(r[0].next_check_at).not.toBeNull(); // проверка наличия запланирована

    expect(published).toHaveLength(1);
    expect(published[0]![0]).toBe(`tenant:${tenantId}:feed`);
    expect(published[0]![1]).toMatchObject({
      title: 'Свежая новость',
      source: { domain: 'feed.test' },
      sentiment: null,
    });

    const src = (
      await admin.query(
        'SELECT items_count, error_count, last_error, last_run_at FROM sources WHERE id = $1',
        [id],
      )
    ).rows[0];
    expect(src).toMatchObject({ items_count: 2, error_count: 0, last_error: null });

    const second = await collectSource(deps(f, published), id);
    expect(second).toMatchObject({ inserted: 0 });
    expect(await rows(id)).toHaveLength(2);
    expect(published).toHaveLength(1);
  });

  it('ошибки копятся и переводят источник в «ошибку» на третьей подряд; успех возвращает в «активен»', async () => {
    const id = await makeSource('flaky.test', { type: 'rss', feedUrl: 'https://flaky.test/rss' });
    const bad = fetcherFrom({ 'https://flaky.test/rss': new Error('Сайт не ответил за отведённое время') });
    for (let i = 1; i <= 3; i++) {
      const s = await collectSource(deps(bad), id);
      expect(s.error).toContain('не ответил');
      const row = (
        await admin.query('SELECT status, error_count, last_error FROM sources WHERE id = $1', [id])
      ).rows[0];
      expect(row.error_count).toBe(i);
      expect(row.status).toBe(i >= 3 ? 'error' : 'active');
    }
    const good = fetcherFrom({
      'https://flaky.test/rss': ok(
        `<rss><channel><item><title>Снова работает</title><link>https://flaky.test/n/1</link></item></channel></rss>`,
        'https://flaky.test/rss',
      ),
    });
    expect(await collectSource(deps(good), id)).toMatchObject({ inserted: 1 });
    expect(
      (await admin.query('SELECT status, error_count, last_error FROM sources WHERE id = $1', [id])).rows[0],
    ).toEqual({ status: 'active', error_count: 0, last_error: null });
  });

  it('HTTP 403/пустая лента — это ошибка источника, а не тихий успех', async () => {
    const id = await makeSource('blocked.test', { type: 'rss', feedUrl: 'https://blocked.test/rss' });
    const f = fetcherFrom({
      'https://blocked.test/rss': {
        status: 403,
        url: 'https://blocked.test/rss',
        redirected: false,
        contentType: '',
        body: '',
      },
    });
    expect((await collectSource(deps(f), id)).error).toContain('HTTP 403');
    const empty = fetcherFrom({
      'https://blocked.test/rss': ok('<html>captcha</html>', 'https://blocked.test/rss'),
    });
    expect((await collectSource(deps(empty), id)).error).toContain('ни одного материала');
  });

  it('источник без настроенного сбора пропускается', async () => {
    const id = await makeSource('noconfig.test', null);
    expect(await collectSource(deps(fetcherFrom({})), id)).toMatchObject({ skipped: 'no_config' });
  });
});

describe('сбор по списку страниц (HTML)', () => {
  const LIST = `<html><body><a href="/news/1">a</a><a href="/news/2">b</a><a href="/news/3">c</a></body></html>`;
  const page = (n: number) =>
    `<html><head><meta property="og:title" content="Материал ${n}"><meta property="og:description" content="Описание ${n}"><meta property="article:published_time" content="2026-10-01T12:0${n}:00+07:00"></head></html>`;

  it('читает только новые страницы, уважает лимит и не перечитывает известные', async () => {
    const id = await makeSource(
      'html.test',
      { type: 'html_list', listUrl: 'https://html.test/', linkPattern: '^/news/\\d+$', maxNew: 2 },
      'CHEERIO',
    );
    const pages: Record<string, FetchResult> = { 'https://html.test/': ok(LIST, 'https://html.test/') };
    for (const n of [1, 2, 3])
      pages[`https://html.test/news/${n}`] = ok(page(n), `https://html.test/news/${n}`);
    const f = fetcherFrom(pages);

    expect(await collectSource(deps(f), id)).toMatchObject({ inserted: 2 });
    expect(f.calls.filter((c) => c.includes('/news/'))).toHaveLength(2);

    const f2 = fetcherFrom(pages);
    expect(await collectSource(deps(f2), id)).toMatchObject({ inserted: 1 });
    expect(f2.calls.filter((c) => c.includes('/news/'))).toHaveLength(1); // известные страницы не запрашиваются
    expect((await rows(id)).map((x) => x.title).sort()).toEqual(['Материал 1', 'Материал 2', 'Материал 3']);
  });

  it('вёрстка изменилась (ссылок нет) — ошибка источника', async () => {
    const id = await makeSource(
      'html2.test',
      { type: 'html_list', listUrl: 'https://html2.test/', linkPattern: '^/news/\\d+$' },
      'CHEERIO',
    );
    const f = fetcherFrom({
      'https://html2.test/': ok('<html><a href="/x">x</a></html>', 'https://html2.test/'),
    });
    expect((await collectSource(deps(f), id)).error).toContain('не найдено ссылок');
  });
});

describe('планировщик', () => {
  it('выбирает источники, которым пора: новые сразу, недавно опрошенные — нет, с ошибками — с отступом', async () => {
    const never = await makeSource('due1.test', { type: 'rss', feedUrl: 'https://due1.test/rss' });
    const recent = await makeSource('due2.test', { type: 'rss', feedUrl: 'https://due2.test/rss' });
    const old = await makeSource('due3.test', { type: 'rss', feedUrl: 'https://due3.test/rss' });
    const failing = await makeSource('due4.test', { type: 'rss', feedUrl: 'https://due4.test/rss' });
    const paused = await makeSource('due5.test', { type: 'rss', feedUrl: 'https://due5.test/rss' });
    const demo = await makeSource('due6.test', null);
    const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
    await admin.query('UPDATE sources SET last_run_at = $2 WHERE id = $1', [recent, ago(3)]);
    await admin.query('UPDATE sources SET last_run_at = $2 WHERE id = $1', [old, ago(11)]);
    await admin.query(
      "UPDATE sources SET last_run_at = $2, error_count = 3, status = 'error' WHERE id = $1",
      [failing, ago(30)],
    ); // отступ 80 мин
    await admin.query("UPDATE sources SET status = 'paused' WHERE id = $1", [paused]);
    const due = await db.raw((q) => selectDueSources(q, NOW));
    expect(due).toContain(never);
    expect(due).toContain(old);
    expect(due).not.toContain(recent);
    expect(due).not.toContain(failing);
    expect(due).not.toContain(paused);
    expect(due).not.toContain(demo); // источники без настроенного сбора (демо-плейсхолдеры) не опрашиваются
  });
});

describe('проверка наличия: удаление на источнике фиксируется, а не стирается', () => {
  async function articleWithCheck(domain: string) {
    const id = await makeSource(domain, null);
    const art = (
      await admin.query<{ id: string }>(
        `INSERT INTO articles (source_id, url, canonical_url, title, lead, published_at, fetched_at, next_check_at)
         VALUES ($1, $2, $2, 'Заметка', 'Лид', $3, $3, $3) RETURNING id`,
        [id, `https://${domain}/news/42`, new Date(NOW.getTime() - 2 * 3600_000)],
      )
    ).rows[0]!.id;
    return art;
  }
  const state = async (id: string) =>
    (await admin.query('SELECT * FROM articles WHERE id = $1', [id])).rows[0];
  const res = (status: number, url: string, redirected = false): FetchResult => ({
    status,
    url,
    redirected,
    contentType: '',
    body: '',
  });

  it('404 → «удалено» с доказательством; запись, заголовок и ссылка остаются; позже вернулся → «восстановлено», факт удаления сохранён', async () => {
    const id = await articleWithCheck('gone.test');
    const url = 'https://gone.test/news/42';

    await verifyArticles({
      run: (fn) => db.raw(fn),
      log,
      fetch: fetcherFrom({ [url]: res(404, url) }),
      now: () => NOW,
      sleep: async () => {},
    });
    let a = await state(id);
    expect(a).toMatchObject({ source_state: 'removed', title: 'Заметка', url, check_count: 1 });
    expect(a.removed_at.toISOString()).toBe(NOW.toISOString());
    expect(a.removal_evidence).toMatchObject({ status: 404, reason: 'http_404', finalUrl: url });
    expect(a.next_check_at).not.toBeNull(); // продолжаем проверять — вдруг временный сбой сайта

    const later = new Date(NOW.getTime() + 7 * 3600_000);
    await admin.query('UPDATE articles SET next_check_at = $2 WHERE id = $1', [id, later]);
    await verifyArticles({
      run: (fn) => db.raw(fn),
      log,
      fetch: fetcherFrom({ [url]: res(200, url) }),
      now: () => later,
      sleep: async () => {},
    });
    a = await state(id);
    expect(a.source_state).toBe('available');
    expect(a.removed_at.toISOString()).toBe(NOW.toISOString()); // исходный факт не стирается
    expect(a.restored_at.toISOString()).toBe(later.toISOString());
    expect(a.removal_evidence).toMatchObject({ reason: 'restored' });
  });

  it('редирект с глубокого адреса на главную — удалено; сбой сайта (503) — состояние не меняется, повтор через 30 минут', async () => {
    const id = await articleWithCheck('redir.test');
    const url = 'https://redir.test/news/42';
    await verifyArticles({
      run: (fn) => db.raw(fn),
      log,
      fetch: fetcherFrom({ [url]: res(200, 'https://redir.test/', true) }),
      now: () => NOW,
      sleep: async () => {},
    });
    expect(await state(id)).toMatchObject({
      source_state: 'removed',
      removal_evidence: expect.objectContaining({ reason: 'redirect_to_root' }),
    });

    const id2 = await articleWithCheck('flaky2.test');
    const url2 = 'https://flaky2.test/news/42';
    const r = await verifyArticles({
      run: (fn) => db.raw(fn),
      log,
      fetch: fetcherFrom({ [url2]: res(503, url2) }),
      now: () => NOW,
      sleep: async () => {},
    });
    expect(r.removed).toBe(0);
    const a = await state(id2);
    expect(a.source_state).toBe('available');
    expect(a.check_count).toBe(0);
    expect(a.next_check_at.toISOString()).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString());
  });

  it('живой материал остаётся доступным, следующая проверка назначается по расписанию, после последней — заканчиваются', async () => {
    const id = await articleWithCheck('alive.test');
    const url = 'https://alive.test/news/42';
    await verifyArticles({
      run: (fn) => db.raw(fn),
      log,
      fetch: fetcherFrom({ [url]: res(200, url) }),
      now: () => NOW,
      sleep: async () => {},
    });
    let a = await state(id);
    expect(a).toMatchObject({ source_state: 'available', check_count: 1 });
    expect(a.next_check_at.getTime()).toBeGreaterThan(NOW.getTime());
    await admin.query('UPDATE articles SET check_count = 4, next_check_at = $2 WHERE id = $1', [id, NOW]);
    await verifyArticles({
      run: (fn) => db.raw(fn),
      log,
      fetch: fetcherFrom({ [url]: res(200, url) }),
      now: () => NOW,
      sleep: async () => {},
    });
    a = await state(id);
    expect(a.check_count).toBe(5);
    expect(a.next_check_at).toBeNull();
  });
});
