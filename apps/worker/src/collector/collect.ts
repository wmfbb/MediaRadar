import type { Queryable } from '@mediaradar/db';
import type { Logger, Publisher } from '../jobs';
import { extractArticle, extractListLinks } from './html';
import { parseFeed } from './feed';
import { safeFetch, type Fetcher } from './http';
import { canonicalUrl, cleanTitle, contentHash, htmlToText, makeLead, parseDate } from './normalize';

export type SourceConfig =
  | { type: 'rss'; feedUrl: string }
  | { type: 'html_list'; listUrl: string; linkPattern: string; maxNew?: number; dateSelector?: string };

export type Run = <T>(fn: (q: Queryable) => Promise<T>) => Promise<T>;

export interface CollectDeps {
  run: Run;
  bus: Publisher;
  log: Logger;
  fetch?: Fetcher;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface CollectSummary {
  sourceId: string;
  skipped?: 'no_config' | 'not_found';
  fetched: number;
  inserted: number;
  failed: number;
  error?: string;
}

interface Candidate {
  url: string;
  canonical: string;
  title: string;
  lead: string | null;
  publishedAt: Date;
  imageUrl: string | null;
  author: string | null;
}

/** Через сколько после сбора впервые проверяем, что материал не удалён; дальше — по расписанию (см. verify.ts). */
export const FIRST_CHECK_DELAY_MS = 3600_000;
/** Только свежие материалы попадают в Live-поток: при первом сборе не засыпаем ленту архивом. */
const LIVE_WINDOW_MS = 6 * 3600_000;
const CHECK_WINDOW_MS = 7 * 24 * 3600_000;
const PAGE_DELAY_MS = 400;
const DEFAULT_MAX_NEW = 30;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function toCandidate(
  raw: {
    url: string;
    title: string;
    description: string;
    publishedAt: string | null;
    imageUrl: string | null;
    author: string | null;
  },
  now: Date,
): Candidate | null {
  const canonical = canonicalUrl(raw.url);
  const title = cleanTitle(raw.title);
  if (!canonical || !title) return null;
  return {
    url: raw.url,
    canonical,
    title,
    lead: makeLead(htmlToText(raw.description)),
    publishedAt: parseDate(raw.publishedAt, now) ?? now,
    imageUrl: raw.imageUrl && /^https?:\/\//i.test(raw.imageUrl) ? raw.imageUrl : null,
    author: raw.author ? htmlToText(raw.author).slice(0, 200) || null : null,
  };
}

async function discover(
  cfg: SourceConfig,
  deps: Required<Pick<CollectDeps, 'fetch' | 'sleep' | 'log'>> & { now: Date },
  existing: (canonicals: string[]) => Promise<Set<string>>,
): Promise<{ items: Candidate[]; failed: number }> {
  const { fetch: get, sleep, log, now } = deps;
  if (cfg.type === 'rss') {
    const res = await get(cfg.feedUrl, { timeoutMs: 20_000, maxBytes: 5 * 1024 * 1024 });
    if (res.status !== 200) throw new Error(`Лента вернула HTTP ${res.status}`);
    const raw = parseFeed(res.body, res.url);
    if (!raw.length) throw new Error('В ленте не найдено ни одного материала (формат изменился?)');
    return {
      items: raw.map((r) => toCandidate(r, now)).filter((c): c is Candidate => c !== null),
      failed: 0,
    };
  }
  const list = await get(cfg.listUrl, { timeoutMs: 20_000 });
  if (list.status !== 200) throw new Error(`Страница списка вернула HTTP ${list.status}`);
  const links = extractListLinks(list.body, list.url, new RegExp(cfg.linkPattern));
  if (!links.length)
    throw new Error('На странице списка не найдено ссылок на материалы (вёрстка изменилась?)');
  const known = await existing(links.map((l) => canonicalUrl(l)).filter((c): c is string => c !== null));
  const fresh = links.filter((l) => {
    const c = canonicalUrl(l);
    return c !== null && !known.has(c);
  });
  const items: Candidate[] = [];
  let failed = 0;
  for (const link of fresh.slice(0, cfg.maxNew ?? DEFAULT_MAX_NEW)) {
    try {
      const page = await get(link, { timeoutMs: 20_000 });
      if (page.status !== 200) throw new Error(`HTTP ${page.status}`);
      const meta = extractArticle(page.body, page.url, { dateSelector: cfg.dateSelector });
      const c = toCandidate({ url: link, ...meta }, now);
      if (c) items.push(c);
      else failed++;
    } catch (e) {
      failed++;
      log.warn({ link, err: (e as Error).message }, 'collect: не удалось прочитать материал');
    }
    await sleep(PAGE_DELAY_MS);
  }
  return { items, failed };
}

/**
 * Один проход по источнику: получить список → прочитать новые материалы → сохранить минимум
 * (заголовок, лид, ссылка, дата, картинка по ссылке) → отправить свежие в Live-поток подписанным тенантам.
 * Ошибки источника не бросаются наружу: они записываются в источник (счётчик, текст, статус), расписание само отступает.
 */
export async function collectSource(deps: CollectDeps, sourceId: string): Promise<CollectSummary> {
  const { run, bus, log } = deps;
  const get = deps.fetch ?? safeFetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = (deps.now ?? (() => new Date()))();

  const src = await run(async (q) => {
    const r = await q.query<{
      id: string;
      name: string;
      domain: string;
      kind: string;
      config: SourceConfig | null;
    }>(
      `SELECT s.id, s.name, s.domain, s.kind,
              (SELECT c.config FROM source_configs c WHERE c.source_id = s.id AND c.is_active ORDER BY c.version DESC LIMIT 1) AS config
         FROM sources s WHERE s.id = $1`,
      [sourceId],
    );
    return r.rows[0] ?? null;
  });
  if (!src) return { sourceId, skipped: 'not_found', fetched: 0, inserted: 0, failed: 0 };
  if (!src.config || (src.config.type !== 'rss' && src.config.type !== 'html_list'))
    return { sourceId, skipped: 'no_config', fetched: 0, inserted: 0, failed: 0 };

  try {
    const { items, failed } = await discover(src.config, { fetch: get, sleep, log, now }, (canonicals) =>
      run(async (q) => {
        const r = await q.query<{ canonical_url: string }>(
          'SELECT canonical_url FROM articles WHERE source_id = $1 AND canonical_url = ANY($2)',
          [sourceId, canonicals],
        );
        return new Set(r.rows.map((x) => x.canonical_url));
      }),
    );

    const unique: Candidate[] = [];
    const seenUrls = new Set<string>();
    for (const it of items)
      if (!seenUrls.has(it.canonical)) {
        seenUrls.add(it.canonical);
        unique.push(it); // при повторе адреса в одной ленте остаётся первое вхождение
      }
    const inserted = await run(async (q) => {
      const rows: Array<{ id: string; item: Candidate }> = [];
      for (const it of unique) {
        const checkable = it.publishedAt.getTime() > now.getTime() - CHECK_WINDOW_MS;
        const res = await q.query<{ id: string }>(
          `INSERT INTO articles (source_id, url, canonical_url, title, lead, published_at, fetched_at, author, image_url, content_hash, next_check_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (source_id, canonical_url) DO NOTHING RETURNING id`,
          [
            sourceId,
            it.url,
            it.canonical,
            it.title,
            it.lead,
            it.publishedAt,
            now,
            it.author,
            it.imageUrl,
            contentHash(it.title, it.lead),
            checkable ? new Date(now.getTime() + FIRST_CHECK_DELAY_MS) : null,
          ],
        );
        if (res.rows[0]) rows.push({ id: res.rows[0].id, item: it });
      }
      await q.query(
        `UPDATE sources SET last_run_at = $2, last_error = NULL, error_count = 0, items_count = items_count + $3,
                status = CASE WHEN status IN ('error', 'needs_attention') THEN 'active' ELSE status END
          WHERE id = $1`,
        [sourceId, now, rows.length],
      );
      return rows;
    });

    // Live: только свежие материалы, каждому подписанному тенанту
    const liveFrom = now.getTime() - LIVE_WINDOW_MS;
    const live = inserted.filter((r) => r.item.publishedAt.getTime() >= liveFrom);
    if (live.length) {
      const tenantIds = await run(async (q) => {
        const r = await q.query<{ worker_source_subscribers: string }>(
          'SELECT worker_source_subscribers($1)',
          [sourceId],
        );
        return r.rows.map((x) => x.worker_source_subscribers);
      });
      for (const { id, item } of live.sort(
        (a, b) => a.item.publishedAt.getTime() - b.item.publishedAt.getTime(),
      )) {
        const event = {
          id,
          title: item.title,
          publishedAt: item.publishedAt.toISOString(),
          source: { id: src.id, name: src.name, domain: src.domain, kind: src.kind },
          topic: null,
          geo: null,
          sentiment: null,
        };
        await Promise.all(tenantIds.map((t) => bus.publish(`tenant:${t}:feed`, event)));
      }
    }
    log.info(
      { sourceId, domain: src.domain, fetched: unique.length, inserted: inserted.length, failed },
      'collect: проход завершён',
    );
    return { sourceId, fetched: unique.length, inserted: inserted.length, failed };
  } catch (e) {
    const message = (e as Error).message.slice(0, 300);
    await run((q) =>
      q.query(
        `UPDATE sources SET last_run_at = $2, last_error = $3, error_count = error_count + 1,
                status = CASE WHEN status = 'active' AND error_count + 1 >= 3 THEN 'error' ELSE status END
          WHERE id = $1`,
        [sourceId, now, message],
      ),
    );
    log.warn({ sourceId, domain: src.domain, err: message }, 'collect: ошибка источника');
    return { sourceId, fetched: 0, inserted: 0, failed: 0, error: message };
  }
}
