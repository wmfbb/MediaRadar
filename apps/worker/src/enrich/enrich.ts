import type { Queryable } from '@mediaradar/db';
import type { Logger } from '../jobs';
import { ANALYZERS, DEFAULT_ANALYZER } from './rules';
import type { Analysis, Analyzer, DictEntity } from './types';

export type Run = <T>(fn: (q: Queryable) => Promise<T>) => Promise<T>;

export interface EnrichDeps {
  run: Run;
  log: Logger;
  analyzer?: Analyzer;
}

/** Итог по материалу — то, что нужно Live-потоку: ключ темы и тональность с учётом ручных правок. */
export interface Enriched {
  id: string;
  topic: string | null;
  sentiment: { label: string; score: number } | null;
}

const BATCH = 300;

/** Словарь персон и организаций: записи entities, загруженные из реестра (attributes.dictionary = true). */
export async function loadDictionary(q: Queryable): Promise<DictEntity[]> {
  const r = await q.query<{ type: 'person' | 'org'; canonical_name: string; aliases: string[] | null }>(
    `SELECT type, canonical_name, attributes -> 'aliases' AS aliases FROM entities
      WHERE type IN ('person', 'org') AND attributes ->> 'dictionary' = 'true' ORDER BY canonical_name`,
  );
  return r.rows.map((e) => ({ type: e.type, name: e.canonical_name, aliases: e.aliases ?? [] }));
}

/**
 * Размечает материалы: тема, тональность, персоны и организации. Идемпотентно — повторный вызов даёт тот же результат.
 * Вручную исправленные тема и тональность (labels_locked) не перезаписываются; персоны и организации обновляются всегда.
 * Сбой на одном материале не останавливает остальные.
 */
export async function enrichArticles(deps: EnrichDeps, ids: string[]): Promise<Map<string, Enriched>> {
  const { run, log } = deps;
  const analyzer = deps.analyzer ?? ANALYZERS[DEFAULT_ANALYZER]!;
  const out = new Map<string, Enriched>();
  if (!ids.length) return out;

  const { dictionary, topics, rows } = await run(async (q) => {
    const dictionary = await loadDictionary(q);
    const topics = new Map(
      (
        await q.query<{ key: string; id: string }>('SELECT key, id FROM topics WHERE tenant_id IS NULL')
      ).rows.map((t) => [t.key, t.id]),
    );
    const rows = (
      await q.query<{ id: string; title: string; lead: string | null }>(
        'SELECT id, title, lead FROM articles WHERE id = ANY($1)',
        [ids],
      )
    ).rows;
    return { dictionary, topics, rows };
  });

  const analysed: Array<{ id: string; a: Analysis }> = [];
  for (const row of rows) {
    try {
      analysed.push({
        id: row.id,
        a: await analyzer.analyze({ title: row.title, lead: row.lead }, dictionary),
      });
    } catch (e) {
      log.warn({ articleId: row.id, err: (e as Error).message }, 'enrich: не удалось разметить материал');
    }
  }

  await run(async (q) => {
    const entityIds = new Map<string, string>();
    for (const { id, a } of analysed) {
      const upd = await q.query<{
        topic_key: string | null;
        sentiment_label: string | null;
        sentiment_score: number | null;
      }>(
        `UPDATE articles SET
            topic_id        = CASE WHEN labels_locked THEN topic_id ELSE $2 END,
            sentiment_label = CASE WHEN labels_locked THEN sentiment_label ELSE $3 END,
            sentiment_score = CASE WHEN labels_locked THEN sentiment_score ELSE $4 END,
            nlp_method = $5, nlp_at = now()
          WHERE id = $1
          RETURNING (SELECT key FROM topics WHERE id = articles.topic_id) AS topic_key, sentiment_label, sentiment_score`,
        [
          id,
          a.topic ? (topics.get(a.topic) ?? null) : null,
          a.sentiment.label,
          a.sentiment.score,
          analyzer.method,
        ],
      );
      const row = upd.rows[0];
      if (!row) continue;
      out.set(id, {
        id,
        topic: row.topic_key,
        sentiment: row.sentiment_label
          ? { label: row.sentiment_label, score: row.sentiment_score ?? 0 }
          : null,
      });

      await q.query('DELETE FROM article_entities WHERE article_id = $1', [id]);
      for (const hit of a.entities) {
        const key = `${hit.type}:${hit.name}`;
        let entityId = entityIds.get(key);
        if (!entityId) {
          // запись находится по (тип, имя); неизвестные организации из шаблонов создаются как автоматические
          const r = await q.query<{ id: string }>(
            `INSERT INTO entities (type, canonical_name, is_public_figure, attributes) VALUES ($1, $2, true, $3)
             ON CONFLICT (type, canonical_name) DO UPDATE SET type = EXCLUDED.type RETURNING id`,
            [hit.type, hit.name, JSON.stringify(hit.auto ? { auto: true } : {})],
          );
          entityId = r.rows[0]!.id;
          entityIds.set(key, entityId);
        }
        await q.query(
          'INSERT INTO article_entities (article_id, entity_id, mentions) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [id, entityId, Math.min(hit.mentions, 32_000)],
        );
      }
    }
  });
  return out;
}

/** Очередь на разметку: материалы без метки версии разметчика, свежие первыми. Сюда же попадает «архив» при первом запуске. */
export async function enrichPending(deps: EnrichDeps, limit = BATCH): Promise<{ processed: number }> {
  const ids = await deps.run(async (q) => {
    const r = await q.query<{ id: string }>(
      'SELECT id FROM articles WHERE nlp_at IS NULL ORDER BY published_at DESC LIMIT $1',
      [limit],
    );
    return r.rows.map((x) => x.id);
  });
  if (!ids.length) return { processed: 0 };
  const done = await enrichArticles(deps, ids);
  deps.log.info({ queued: ids.length, processed: done.size }, 'enrich: партия размечена');
  return { processed: done.size };
}

/** Перечитать все материалы заново (после смены словаря или версии разметчика). Ручные правки сохраняются. */
export async function resetEnrichment(run: Run): Promise<number> {
  return run(async (q) => {
    const r = await q.query("UPDATE articles SET nlp_at = NULL WHERE nlp_method IS DISTINCT FROM 'demo'");
    return r.rowCount ?? 0;
  });
}
