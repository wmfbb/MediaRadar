import type pg from 'pg';

/**
 * Стартовый реестр реальных источников Алтайского края. Подобран по рейтингу цитируемости «Медиалогии»
 * (I полугодие 2026) и проверен вживую: у каждого источника в день проверки отвечала лента или страница списка
 * со свежими материалами. Зеркала (например, vestialtai.ru = vesti22.tv) не дублируются.
 * Сайты без RSS читаются по списку страниц: ссылки по шаблону, затем заголовок/лид/дата из разметки страницы.
 */
export interface RealSource {
  name: string;
  domain: string;
  kind: 'NEWS_SITE' | 'GOV_PORTAL';
  cron: string;
  trust: number;
  config:
    | { type: 'rss'; feedUrl: string }
    | { type: 'html_list'; listUrl: string; linkPattern: string; maxNew?: number; dateSelector?: string };
}

const STARTER_NOTE = 'Стартовый реестр: проверено вживую';

export const REAL_SOURCES: RealSource[] = [
  {
    name: 'Толк',
    domain: 'tolknews.ru',
    kind: 'NEWS_SITE',
    cron: '*/10 * * * *',
    trust: 80,
    config: { type: 'rss', feedUrl: 'https://tolknews.ru/rss.xml' },
  },
  {
    name: 'ИА Банкфакс',
    domain: 'bankfax.ru',
    kind: 'NEWS_SITE',
    cron: '*/10 * * * *',
    trust: 80,
    config: { type: 'rss', feedUrl: 'https://bankfax.ru/rss.xml' },
  },
  {
    name: 'ИА Амител',
    domain: 'amic.ru',
    kind: 'NEWS_SITE',
    cron: '*/10 * * * *',
    trust: 80,
    config: { type: 'rss', feedUrl: 'https://feeds.feedburner.com/amic/news' },
  },
  {
    name: 'ГТРК «Алтай» (Вести Алтай)',
    domain: 'vesti22.tv',
    kind: 'NEWS_SITE',
    cron: '*/15 * * * *',
    trust: 85,
    config: { type: 'rss', feedUrl: 'https://vesti22.tv/news/rss/' },
  },
  {
    name: 'Бийский рабочий',
    domain: 'biwork.ru',
    kind: 'NEWS_SITE',
    cron: '*/15 * * * *',
    trust: 75,
    config: { type: 'rss', feedUrl: 'https://biwork.ru/rss.xml' },
  },
  {
    name: 'НГС22',
    domain: 'ngs22.ru',
    kind: 'NEWS_SITE',
    cron: '*/10 * * * *',
    trust: 70,
    config: { type: 'rss', feedUrl: 'https://ngs22.ru/rss-feeds/rss.xml' },
  },
  {
    name: 'АиФ Алтай',
    domain: 'altai.aif.ru',
    kind: 'NEWS_SITE',
    cron: '*/15 * * * *',
    trust: 70,
    config: { type: 'rss', feedUrl: 'https://altai.aif.ru/rss/googlenews' },
  },
  {
    name: 'Вечерний Барнаул',
    domain: 'barnaul.press',
    kind: 'NEWS_SITE',
    cron: '*/15 * * * *',
    trust: 75,
    config: { type: 'rss', feedUrl: 'https://barnaul.press/news/rss' },
  },
  {
    name: 'Каменские новости',
    domain: 'izvestiy-kamen.ru',
    kind: 'NEWS_SITE',
    cron: '*/30 * * * *',
    trust: 65,
    config: { type: 'rss', feedUrl: 'https://izvestiy-kamen.ru/feed/' },
  },
  {
    name: 'Местное время (Рубцовск)',
    domain: 'rubtsovskmv.ru',
    kind: 'NEWS_SITE',
    cron: '*/30 * * * *',
    trust: 65,
    config: { type: 'rss', feedUrl: 'https://rubtsovskmv.ru/feed/' },
  },
  {
    name: 'Алтайское краевое Законодательное Собрание',
    domain: 'akzs.ru',
    kind: 'GOV_PORTAL',
    cron: '*/30 * * * *',
    trust: 95,
    config: { type: 'rss', feedUrl: 'https://akzs.ru/news/rss/' },
  },
  {
    name: 'ГУ МЧС России по Алтайскому краю',
    domain: '22.mchs.gov.ru',
    kind: 'GOV_PORTAL',
    cron: '*/30 * * * *',
    trust: 95,
    config: { type: 'rss', feedUrl: 'https://22.mchs.gov.ru/rss/news' },
  },
  {
    name: 'Катунь 24',
    domain: 'katun24.ru',
    kind: 'NEWS_SITE',
    cron: '*/10 * * * *',
    trust: 80,
    config: {
      type: 'html_list',
      listUrl: 'https://katun24.ru/',
      linkPattern: '^/news/\\d+$',
      dateSelector: '.node--news__date time',
    },
  },
  {
    name: 'ИА Атмосфера',
    domain: 'asferainfo.ru',
    kind: 'NEWS_SITE',
    cron: '*/15 * * * *',
    trust: 65,
    config: { type: 'html_list', listUrl: 'https://www.asferainfo.ru/', linkPattern: '^/news/\\d+-' },
  },
  {
    name: 'Комсомольская правда — Барнаул',
    domain: 'alt.kp.ru',
    kind: 'NEWS_SITE',
    cron: '*/15 * * * *',
    trust: 70,
    config: {
      type: 'html_list',
      listUrl: 'https://www.alt.kp.ru/online/',
      linkPattern: '^/online/news/\\d+/?$',
    },
  },
  {
    name: 'Алтапресс',
    domain: 'altapress.ru',
    kind: 'NEWS_SITE',
    cron: '*/15 * * * *',
    trust: 70,
    config: { type: 'html_list', listUrl: 'https://altapress.ru/news', linkPattern: '^/story/.+-\\d{5,}$' },
  },
];

/**
 * Добавляет реальные источники в каталог и подписывает на них тенант «altai-krai».
 * Идемпотентно: существующие источники не дублируются, настроенный сбор не перезаписывается.
 */
export async function seedRealSources(
  client: pg.Client,
  tenantSlug = 'altai-krai',
): Promise<{ added: number; total: number }> {
  const tenant = await client.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [tenantSlug]);
  if (!tenant.rows[0])
    throw new Error(`Тенант ${tenantSlug} не найден — сначала загрузите данные (pnpm db:seed)`);
  const tenantId = tenant.rows[0].id;
  let added = 0;
  for (const s of REAL_SOURCES) {
    const found = await client.query<{ id: string }>(
      'SELECT id FROM sources WHERE owner_tenant_id IS NULL AND lower(domain) = lower($1)',
      [s.domain],
    );
    let id = found.rows[0]?.id;
    if (!id) {
      const url = s.config.type === 'rss' ? `https://${s.domain}/` : new URL(s.config.listUrl).origin + '/';
      const ins = await client.query<{ id: string }>(
        `INSERT INTO sources (kind, name, url, domain, parser, cron, trust_score, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{"demo": false}') RETURNING id`,
        [s.kind, s.name, url, s.domain, s.config.type === 'rss' ? 'RSS' : 'CHEERIO', s.cron, s.trust],
      );
      id = ins.rows[0]!.id;
      added++;
    }
    const active = await client.query<{ config: unknown; note: string | null }>(
      'SELECT config, note FROM source_configs WHERE source_id = $1 AND is_active ORDER BY version DESC LIMIT 1',
      [id],
    );
    const current = active.rows[0];
    const isStarter = !current || (current.note ?? '').startsWith(STARTER_NOTE);
    // Настройки, которые менял человек, не перезаписываем; стартовые обновляем новой версией.
    if (isStarter && JSON.stringify(current?.config) !== JSON.stringify(s.config)) {
      if (current)
        await client.query('UPDATE source_configs SET is_active = false WHERE source_id = $1', [id]);
      await client.query(
        `INSERT INTO source_configs (source_id, version, config, note)
         VALUES ($1, COALESCE((SELECT max(version) FROM source_configs WHERE source_id = $1), 0) + 1, $2, $3)`,
        [id, JSON.stringify(s.config), STARTER_NOTE],
      );
    }
    await client.query(
      'INSERT INTO tenant_sources (tenant_id, source_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [tenantId, id],
    );
  }
  return { added, total: REAL_SOURCES.length };
}
