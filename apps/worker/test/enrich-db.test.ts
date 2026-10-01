import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REAL_ENTITIES, createDb, seedRealEntities, type Db } from '@mediaradar/db';
import { enrichArticles, enrichPending, resetEnrichment, type Run } from '../src/enrich/enrich';
import { TEST_DB } from './global-setup';

const base = process.env.TEST_PG_URL ?? 'postgres://mediaradar:mediaradar_dev@localhost:5432';
const log = { info: () => {}, warn: () => {}, error: () => {} };

let admin: pg.Client;
let db: Db;
let sourceId: string;
const run: Run = (fn) => db.raw(fn);

beforeAll(async () => {
  admin = new pg.Client({ connectionString: `${base}/${TEST_DB}` });
  await admin.connect();
  db = createDb(`postgres://app_worker:app_worker_dev@localhost:5432/${TEST_DB}`, {
    max: 3,
    applicationName: 'test-enrich',
  });
  await seedRealEntities(admin);
  sourceId = (
    await admin.query<{ id: string }>(
      `INSERT INTO sources (kind, name, url, domain, parser, meta) VALUES ('NEWS_SITE', 'enrich.test', 'https://enrich.test/', 'enrich.test', 'RSS', '{}') RETURNING id`,
    )
  ).rows[0]!.id;
});
afterAll(async () => {
  await admin.query('DELETE FROM sources WHERE id = $1', [sourceId]);
  await admin.query("DELETE FROM entities WHERE attributes ->> 'auto' = 'true'");
  await admin.end();
  await db.close();
});

let n = 0;
async function article(title: string, lead: string | null = null): Promise<string> {
  n++;
  return (
    await admin.query<{ id: string }>(
      `INSERT INTO articles (source_id, url, canonical_url, title, lead, published_at)
       VALUES ($1, $2, $2, $3, $4, now()) RETURNING id`,
      [sourceId, `https://enrich.test/${n}`, title, lead],
    )
  ).rows[0]!.id;
}
const state = async (id: string) =>
  (
    await admin.query(
      `SELECT a.nlp_method, a.nlp_at, a.sentiment_label, a.sentiment_score, a.labels_locked, t.key AS topic
         FROM articles a LEFT JOIN topics t ON t.id = a.topic_id WHERE a.id = $1`,
      [id],
    )
  ).rows[0];
const entities = async (id: string) =>
  (
    await admin.query<{ type: string; canonical_name: string; mentions: number }>(
      `SELECT e.type, e.canonical_name, ae.mentions FROM article_entities ae JOIN entities e ON e.id = ae.entity_id
        WHERE ae.article_id = $1`,
      [id],
    )
  ).rows;

describe('разметка материалов в БД', () => {
  it('словарь загружается из реестра и не дублируется при повторной загрузке', async () => {
    await seedRealEntities(admin);
    const r = await admin.query(
      "SELECT count(*)::int AS n FROM entities WHERE attributes ->> 'dictionary' = 'true'",
    );
    expect(r.rows[0].n).toBe(REAL_ENTITIES.length);
  });

  it('пишет тему, тональность, персон и организации; отмечает версию разметчика', async () => {
    const id = await article(
      'Томенко открыл новую школу в Бийске',
      'Администрация Бийска поддержала проект. ООО «Строй-Алтай» завершило работы досрочно.',
    );
    const out = await enrichArticles({ run, log }, [id]);
    expect(out.get(id)).toMatchObject({
      topic: 'soc',
      sentiment: { label: expect.stringMatching(/^(P|VP)$/) },
    });
    expect(await state(id)).toMatchObject({ nlp_method: 'rules-1', topic: 'soc', labels_locked: false });
    expect((await state(id)).nlp_at).not.toBeNull();
    const found = await entities(id);
    expect(found).toHaveLength(3);
    expect(found).toEqual(
      expect.arrayContaining([
        { type: 'org', canonical_name: 'Администрация Бийска', mentions: 1 },
        { type: 'org', canonical_name: 'ООО «Строй-Алтай»', mentions: 1 },
        { type: 'person', canonical_name: 'Виктор Томенко', mentions: 1 },
      ]),
    );
  });

  it('повторный запуск даёт тот же результат без дублей', async () => {
    const id = await article('Погибли два человека в ДТП', 'МЧС и МВД сообщили подробности');
    await enrichArticles({ run, log }, [id]);
    const first = { s: await state(id), e: await entities(id) };
    await enrichArticles({ run, log }, [id]);
    expect(await entities(id)).toHaveLength(first.e.length);
    expect(first.e.map((e) => e.canonical_name).sort()).toEqual(['МВД', 'МЧС']);
    expect((await state(id)).sentiment_label).toBe(first.s.sentiment_label);
    expect(first.s.sentiment_label).toBe('VN');
  });

  it('вручную исправленные тема и тональность не затираются, персоны и организации обновляются', async () => {
    const id = await article('Погибли два человека в ДТП');
    await enrichArticles({ run, log }, [id]);
    const econ = (await admin.query("SELECT id FROM topics WHERE key = 'econ' AND tenant_id IS NULL")).rows[0]
      .id;
    await admin.query(
      "UPDATE articles SET labels_locked = true, sentiment_label = 'P', sentiment_score = 0.4, topic_id = $2, title = 'Погибли двое. Сообщил Путин' WHERE id = $1",
      [id, econ],
    );
    const out = await enrichArticles({ run, log }, [id]);
    expect(await state(id)).toMatchObject({
      sentiment_label: 'P',
      sentiment_score: 0.4,
      topic: 'econ',
      labels_locked: true,
    });
    expect(out.get(id)).toMatchObject({ topic: 'econ', sentiment: { label: 'P', score: 0.4 } }); // в Live уходит итоговая метка
    expect((await entities(id)).map((e) => e.canonical_name)).toEqual(['Владимир Путин']);
  });

  it('очередь берёт только неразмеченное; reset перечитывает всё, кроме демо-материалов', async () => {
    const a = await article('Школьники Бийска выиграли олимпиаду');
    const demo = await article('Демо-материал');
    await admin.query("UPDATE articles SET nlp_method = 'demo', nlp_at = now() WHERE id = $1", [demo]);

    const first = await enrichPending({ run, log }, 500);
    expect(first.processed).toBeGreaterThanOrEqual(1);
    expect((await state(a)).nlp_method).toBe('rules-1');
    expect((await state(demo)).nlp_method).toBe('demo'); // демо уже «размечено» сидом
    expect((await enrichPending({ run, log }, 500)).processed).toBe(0);

    await resetEnrichment(run);
    expect((await state(a)).nlp_at).toBeNull();
    expect((await state(demo)).nlp_at).not.toBeNull();
  });
});
