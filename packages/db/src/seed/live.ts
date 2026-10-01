import { createHash } from 'node:crypto';
import { SENTIMENTS, TOPIC_PRESET, uuidv7, type SentimentLabel, type TopicKey } from '@mediaradar/core';
import type { Queryable } from '../client';
import { ALTAI_CITIES, ALTAI_DISTRICTS, BODIES, ORGS, PERSONS, TITLES } from './data';
import { createRng, type Rng } from './rng';

export interface LiveArticle {
  id: string;
  title: string;
  publishedAt: string;
  source: { id: string; name: string; domain: string; kind: string };
  topic: string;
  geo: string | null;
  sentiment: { label: SentimentLabel; score: number };
  /** Тенанты, подписанные на источник: им уходит событие реального времени. */
  tenantIds: string[];
}

const rng: Rng = createRng(Date.now() % 2 ** 31);

/**
 * Демо-имитатор потока: создаёт один синтетический материал в случайном активном общем источнике.
 * Работает от имени воркера (роль app_worker). В production не используется (включается DEMO_LIVE=true).
 */
export async function createLiveDemoArticle(q: Queryable): Promise<LiveArticle | null> {
  const src = (await q.query<{ id: string; name: string; domain: string; kind: string; topic_key: string | null; city: string | null }>(
    `SELECT s.id, s.name, s.domain, s.kind, t.key AS topic_key, g.name AS city
       FROM sources s LEFT JOIN topics t ON t.id = s.topic_id LEFT JOIN geo_places g ON g.id = s.geo_id
      WHERE s.owner_tenant_id IS NULL AND s.status = 'active' AND s.meta ->> 'demo' = 'true'
      ORDER BY random() LIMIT 1`)).rows[0];
  if (!src) return null;

  const topic: TopicKey = (src.topic_key && rng.chance(0.6) ? src.topic_key : rng.pick(TOPIC_PRESET).key) as TopicKey;
  const city = src.city ?? rng.pick(ALTAI_CITIES)[0];
  const title = rng.pick(TITLES[topic])
    .replace('{n}', String(rng.int(3, 120))).replace('{pct}', String(rng.int(2, 31))).replace('{city}', city)
    .replace('{district}', rng.pick(ALTAI_DISTRICTS).replace('район', 'района'));
  const body = `${rng.pick(BODIES)} ${rng.pick(BODIES)}`;
  const label = rng.weighted<SentimentLabel>([['VP', 14], ['P', 22], ['N', 38], ['NG', 18], ['VN', 8]]);
  const lo = { VP: SENTIMENTS.VP.min, P: SENTIMENTS.P.min, N: SENTIMENTS.N.min, NG: SENTIMENTS.NG.min, VN: -1 }[label];
  const hi = { VP: 1, P: SENTIMENTS.VP.min, N: SENTIMENTS.P.min, NG: SENTIMENTS.N.min, VN: SENTIMENTS.NG.min }[label];
  const score = Math.round((lo + rng.next() * (hi - lo)) * 1000) / 1000;
  const id = uuidv7();
  const num = Date.now() % 1_000_000_000;
  const url = src.domain.includes('/') ? `https://${src.domain}/live-${num}` : `https://${src.domain}/news/live-${num}`;
  const publishedAt = new Date();

  await q.query(
    `INSERT INTO articles (id, source_id, url, canonical_url, title, lead, published_at, author, content_hash, topic_id, geo_id, sentiment_label, sentiment_score, views)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, (SELECT id FROM topics WHERE key = $9 AND tenant_id IS NULL), (SELECT id FROM geo_places WHERE name = $10 LIMIT 1), $11, $12, $13)`,
    [id, src.id, url, title, body.split('. ')[0]! + '.', publishedAt, rng.pick(PERSONS), createHash('sha256').update(title + body).digest('hex'), topic, city, label, score, rng.int(5, 200)],
  );
  await q.query('INSERT INTO article_texts (article_id, body_text) VALUES ($1, $2)', [id, body]);
  for (const [name, type] of [[rng.pick(PERSONS), 'person'], [rng.pick(ORGS), 'org']] as const)
    await q.query(`INSERT INTO article_entities (article_id, entity_id, mentions) SELECT $1, id, 1 FROM entities WHERE type = $2 AND canonical_name = $3 ON CONFLICT DO NOTHING`, [id, type, name]);
  await q.query('UPDATE sources SET items_count = items_count + 1, last_run_at = now() WHERE id = $1', [src.id]);

  const tenants = (await q.query<{ worker_source_subscribers: string }>('SELECT worker_source_subscribers($1)', [src.id])).rows.map((r) => r.worker_source_subscribers);
  return { id, title, publishedAt: publishedAt.toISOString(), source: { id: src.id, name: src.name, domain: src.domain, kind: src.kind }, topic, geo: city, sentiment: { label, score }, tenantIds: tenants };
}
