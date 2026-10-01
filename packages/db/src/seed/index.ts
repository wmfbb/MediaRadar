import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  SENTIMENTS,
  TOPIC_PRESET,
  hashPassword,
  uuidv7,
  type SentimentLabel,
  type TopicKey,
} from '@mediaradar/core';
import {
  ALERTS,
  ALTAI_CITIES,
  ALTAI_DISTRICTS,
  BODIES,
  HOUR_WEIGHTS,
  ORGS,
  PARSER_CONFIGS,
  PERSONS,
  PRIVATE_SOURCE,
  REPUBLIC_SOURCES,
  SOURCES,
  TITLES,
  type SourceSeed,
} from './data';
import { createRng, type Rng } from './rng';

export const DEMO_PASSWORD = 'Demo-Passw0rd!';

export interface DemoAccount {
  email: string;
  name: string;
  tenant: 'altai-krai' | 'demo-republic' | null;
  role: string | null;
  platformRole?: string;
  blocked?: boolean;
  scope?: object;
  lastLoginMin?: number;
}

export const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    email: 'a.prokhorov@altai.media',
    name: 'Алексей Прохоров',
    tenant: 'altai-krai',
    role: 'OWNER',
    lastLoginMin: 1,
  },
  {
    email: 'n.sergeeva@altai.media',
    name: 'Наталья Сергеева',
    tenant: 'altai-krai',
    role: 'ADMIN',
    lastLoginMin: 55,
  },
  {
    email: 'm.kovaleva@altai.media',
    name: 'Мария Ковалёва',
    tenant: 'altai-krai',
    role: 'ANALYST',
    lastLoginMin: 12,
  },
  {
    email: 'd.esin@altai.media',
    name: 'Дмитрий Есин',
    tenant: 'altai-krai',
    role: 'EDITOR',
    lastLoginMin: 60,
  },
  {
    email: 'o.timoshina@altai.media',
    name: 'Ольга Тимошина',
    tenant: 'altai-krai',
    role: 'MODERATOR',
    lastLoginMin: 180,
  },
  {
    email: 's.bashlykov@client.ru',
    name: 'Сергей Башлыков',
    tenant: 'altai-krai',
    role: 'VIEWER',
    blocked: true,
    lastLoginMin: 2880,
  },
  {
    email: 'i.lapteva@agro22.ru',
    name: 'Ирина Лаптева',
    tenant: 'altai-krai',
    role: 'VIEWER',
    scope: { topics: ['agro', 'food'] },
    lastLoginMin: 300,
  },
  {
    email: 'owner@altai-republic.demo',
    name: 'Владимир Демидов',
    tenant: 'demo-republic',
    role: 'OWNER',
    lastLoginMin: 700,
  },
  {
    email: 'admin@mediaradar.local',
    name: 'Администратор платформы',
    tenant: null,
    role: null,
    platformRole: 'SUPER_ADMIN',
    lastLoginMin: 5,
  },
];

export interface SeedSummary {
  tenants: Record<string, string>;
  users: Record<string, string>;
  sources: number;
  articles: number;
  privateArticleIds: string[];
  sharedSourceIds: string[];
}

export interface SeedOptions {
  now?: Date;
  seed?: number;
  articles?: number;
  password?: string;
}

async function bulk(
  client: pg.Client,
  table: string,
  cols: string[],
  rows: unknown[][],
  suffix = '',
): Promise<void> {
  const CHUNK = 250;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk.map((r, ri) => `(${r.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(',')})`);
    await client.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')} ${suffix}`,
      chunk.flat(),
    );
  }
}

/** Удаляет демо-данные (справочные данные — роли, тарифы, пресет тем — сохраняются). */
export async function resetDemo(client: pg.Client): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query('ALTER TABLE audit_log DISABLE TRIGGER USER');
    await client.query('DELETE FROM audit_log');
    await client.query('ALTER TABLE audit_log ENABLE TRIGGER USER');
    for (const t of ['tenants', 'users', 'sources', 'geo_places', 'entities', 'settings', 'settings_history'])
      await client.query(`DELETE FROM ${t}`);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

function fill(rng: Rng, tpl: string, city: string | null): string {
  return tpl
    .replace('{n}', String(rng.int(3, 120)))
    .replace('{pct}', String(rng.int(2, 31)))
    .replace('{city}', city ?? rng.pick(ALTAI_CITIES)[0])
    .replace('{district}', rng.pick(ALTAI_DISTRICTS).replace('район', 'района'));
}

const SENT_BASE: Array<[SentimentLabel, number]> = [
  ['VP', 14],
  ['P', 22],
  ['N', 38],
  ['NG', 18],
  ['VN', 8],
];
function sentimentFor(rng: Rng, topic: TopicKey): { label: SentimentLabel; score: number } {
  const bias =
    topic === 'fuel' ? [0.5, 0.7, 1, 1.9, 2.2] : topic === 'agro' ? [1.6, 1.3, 1, 0.7, 0.5] : [1, 1, 1, 1, 1];
  const label = rng.weighted(SENT_BASE.map(([l, w], i) => [l, w * bias[i]!] as const));
  const hi = {
    VP: 1,
    P: SENTIMENTS.VP.min,
    N: SENTIMENTS.P.min,
    NG: SENTIMENTS.N.min,
    VN: SENTIMENTS.NG.min,
  }[label];
  const lo = {
    VP: SENTIMENTS.VP.min,
    P: SENTIMENTS.P.min,
    N: SENTIMENTS.N.min,
    NG: SENTIMENTS.NG.min,
    VN: -1,
  }[label];
  return { label, score: Math.round((lo + rng.next() * (hi - lo)) * 1000) / 1000 };
}

/** Момент публикации: пик рабочих часов по Asia/Barnaul (UTC+7); плотность слегка растёт к «сегодня» (умеренный рост, без скачков). */
function publishedAt(rng: Rng, now: Date): Date {
  const daysAgo = Math.min(89, Math.floor(90 * rng.next() ** 1.15));
  const hour = rng.weighted(HOUR_WEIGHTS.map((w, h) => [h, w] as const));
  const base = new Date(now);
  base.setUTCHours(0, 0, 0, 0);
  let t =
    base.getTime() - daysAgo * 864e5 + (hour - 7) * 3600e3 + rng.int(0, 59) * 60e3 + rng.int(0, 59) * 1e3;
  if (t > now.getTime()) t -= 864e5;
  return new Date(t);
}

export async function seedDemo(client: pg.Client, opts: SeedOptions = {}): Promise<SeedSummary> {
  const now = opts.now ?? new Date();
  const rng = createRng(opts.seed ?? 20261001);
  const totalArticles = opts.articles ?? 1500;
  const passwordHash = await hashPassword(opts.password ?? DEMO_PASSWORD);
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);

  await client.query('BEGIN');
  try {
    // --- территории -----------------------------------------------------------------------
    const countryId = uuidv7();
    const regionId = uuidv7();
    const repId = uuidv7();
    const geoRows: unknown[][] = [
      [countryId, null, 'country', 'Россия', null, null, null],
      [regionId, countryId, 'region', 'Алтайский край', null, null, 2_100_000],
      [repId, countryId, 'region', 'Республика Алтай', null, null, 220_000],
    ];
    const geoByName = new Map<string, string>();
    for (const [name, lat, lon, pop] of ALTAI_CITIES) {
      const id = uuidv7();
      geoByName.set(name, id);
      geoRows.push([id, regionId, 'city', name, lat, lon, pop]);
    }
    for (const name of ALTAI_DISTRICTS) {
      const id = uuidv7();
      geoByName.set(name, id);
      geoRows.push([id, regionId, 'district', name, null, null, null]);
    }
    const gaId = uuidv7();
    geoByName.set('Горно-Алтайск', gaId);
    geoRows.push([gaId, repId, 'city', 'Горно-Алтайск', 51.9581, 85.9603, 64000]);
    await bulk(
      client,
      'geo_places',
      ['id', 'parent_id', 'level', 'name', 'lat', 'lon', 'population'],
      geoRows,
    );

    // --- справочники из reference-sync -----------------------------------------------------
    const topicId = new Map<string, string>(
      (
        await client.query<{ key: string; id: string }>('SELECT key, id FROM topics WHERE tenant_id IS NULL')
      ).rows.map((r) => [r.key, r.id]),
    );
    const roleId = new Map<string, string>(
      (
        await client.query<{ key: string; id: string }>('SELECT key, id FROM roles WHERE tenant_id IS NULL')
      ).rows.map((r) => [r.key, r.id]),
    );
    if (topicId.size < TOPIC_PRESET.length || roleId.size < 6)
      throw new Error('Сначала выполните миграции (pnpm db:migrate): нет справочных данных');

    // --- тенанты ---------------------------------------------------------------------------
    const tenantId = { 'altai-krai': uuidv7(), 'demo-republic': uuidv7() };
    await bulk(
      client,
      'tenants',
      ['id', 'slug', 'name', 'region_profile', 'branding'],
      [
        [
          tenantId['altai-krai'],
          'altai-krai',
          'Алтайский край',
          JSON.stringify({
            country: 'RU',
            region: 'Алтайский край',
            core: 'Барнаул',
            timezone: 'Asia/Barnaul',
            languages: ['ru'],
          }),
          JSON.stringify({ productName: 'Алтай.Медиа', color: '#3363ff' }),
        ],
        [
          tenantId['demo-republic'],
          'demo-republic',
          'Республика Алтай',
          JSON.stringify({
            country: 'RU',
            region: 'Республика Алтай',
            core: 'Горно-Алтайск',
            timezone: 'Asia/Barnaul',
            languages: ['ru'],
          }),
          JSON.stringify({ productName: 'Горный Алтай — Медиа', color: '#0ea5e9' }),
        ],
      ],
    );
    await bulk(
      client,
      'subscriptions',
      ['tenant_id', 'plan_key', 'status', 'period_start', 'period_end'],
      [
        [tenantId['altai-krai'], 'pro', 'active', ago(60 * 24 * 16), new Date(now.getTime() + 14 * 864e5)],
        [
          tenantId['demo-republic'],
          'starter',
          'active',
          ago(60 * 24 * 5),
          new Date(now.getTime() + 25 * 864e5),
        ],
      ],
    );

    // --- пользователи и членство -----------------------------------------------------------
    const userId: Record<string, string> = {};
    const userRows: unknown[][] = [];
    for (const a of DEMO_ACCOUNTS) {
      userId[a.email] = uuidv7();
      userRows.push([
        userId[a.email],
        a.email,
        passwordHash,
        a.name,
        a.blocked ? 'blocked' : 'active',
        a.platformRole ?? null,
        ago(a.lastLoginMin ?? 60),
      ]);
    }
    await bulk(
      client,
      'users',
      ['id', 'email', 'password_hash', 'display_name', 'status', 'platform_role', 'last_login_at'],
      userRows,
    );
    const memberRows: unknown[][] = DEMO_ACCOUNTS.filter((a) => a.tenant && a.role).map((a) => [
      tenantId[a.tenant!],
      userId[a.email],
      roleId.get(a.role!),
      JSON.stringify(a.scope ?? {}),
      a.blocked ? 'blocked' : 'active',
    ]);
    // Мария Ковалёва работает в двух тенантах (демонстрация переключения)
    memberRows.push([
      tenantId['demo-republic'],
      userId['m.kovaleva@altai.media'],
      roleId.get('VIEWER'),
      '{}',
      'active',
    ]);
    await bulk(client, 'memberships', ['tenant_id', 'user_id', 'role_id', 'scope', 'status'], memberRows);

    // --- источники -------------------------------------------------------------------------
    const mkSource = (s: SourceSeed, owner: string | null) => {
      const id = uuidv7();
      const url = `https://${s.domain}`;
      return {
        id,
        seed: s,
        owner,
        row: [
          id,
          owner,
          s.kind,
          s.name,
          url,
          s.domain,
          s.city ? (geoByName.get(s.city) ?? null) : null,
          topicId.get(s.topic),
          s.parser,
          s.cron,
          s.status,
          s.trust,
          ago(s.lastMin),
          s.status === 'error' ? 'HTTP 403: сайт отклонил запрос (возможна антибот-защита)' : null,
          s.errs,
          JSON.stringify({ demo: true }),
        ],
      };
    };
    const main = SOURCES.map((s) => mkSource(s, null));
    const rep = REPUBLIC_SOURCES.map((s) => mkSource(s, null));
    const priv = mkSource(PRIVATE_SOURCE, tenantId['demo-republic']);
    const allSources = [...main, ...rep, priv];
    await bulk(
      client,
      'sources',
      [
        'id',
        'owner_tenant_id',
        'kind',
        'name',
        'url',
        'domain',
        'geo_id',
        'topic_id',
        'parser',
        'cron',
        'status',
        'trust_score',
        'last_run_at',
        'last_error',
        'error_count',
        'meta',
      ],
      allSources.map((s) => s.row),
    );

    const subRows: unknown[][] = [
      ...main.map((s) => [tenantId['altai-krai'], s.id]),
      ...rep.map((s) => [tenantId['demo-republic'], s.id]),
      ...main.filter((s) => s.seed.sharedWithRepublic).map((s) => [tenantId['demo-republic'], s.id]),
      [tenantId['demo-republic'], priv.id], // приватный источник тенанта тоже входит в его подписки
    ];
    await bulk(client, 'tenant_sources', ['tenant_id', 'source_id'], subRows);
    await bulk(
      client,
      'source_configs',
      ['source_id', 'version', 'config', 'note'],
      allSources.map((s) => [
        s.id,
        1,
        JSON.stringify(PARSER_CONFIGS[s.seed.parser]),
        'Начальная конфигурация (демо)',
      ]),
    );

    // --- сущности --------------------------------------------------------------------------
    const personIds = PERSONS.map(() => uuidv7());
    const orgIds = ORGS.map(() => uuidv7());
    await bulk(
      client,
      'entities',
      ['id', 'type', 'canonical_name'],
      [...PERSONS.map((n, i) => [personIds[i], 'person', n]), ...ORGS.map((n, i) => [orgIds[i], 'org', n])],
    );

    // --- материалы -------------------------------------------------------------------------
    const artRows: unknown[][] = [];
    const textRows: unknown[][] = [];
    const entRows: unknown[][] = [];
    const privateArticleIds: string[] = [];
    const counters = new Map<string, number>();

    const makeArticle = (src: (typeof allSources)[number], forcePrivate = false) => {
      const s = src.seed;
      const n = (counters.get(src.id) ?? 0) + 1;
      counters.set(src.id, n);
      const topic: TopicKey = rng.chance(0.6) ? s.topic : rng.pick(TOPIC_PRESET).key;
      const city = s.city && rng.chance(0.7) ? s.city : null;
      const title = fill(rng, rng.pick(TITLES[topic]), city);
      const body = `${rng.pick(BODIES)} ${rng.pick(BODIES)}`;
      const lead = body.split('. ')[0]! + '.';
      const sent = sentimentFor(rng, topic);
      const geo = city
        ? geoByName.get(city)!
        : geoByName.get(
            rng.weighted([
              ['Барнаул', 40],
              ['Бийск', 12],
              ['Рубцовск', 8],
              ['Новоалтайск', 5],
              ...ALTAI_DISTRICTS.slice(0, 12).map((d) => [d, 2] as const),
            ] as const),
          )!;
      const id = uuidv7();
      const num = 10000 + n * 7 + rng.int(0, 6);
      const url = s.domain.includes('/') ? `https://${s.domain}/${num}` : `https://${s.domain}/news/${num}`;
      const pending = !forcePrivate && (s.kind === 'FORUM' || s.kind === 'TELEGRAM') && rng.chance(0.05);
      artRows.push([
        id,
        src.id,
        url,
        url,
        title,
        lead,
        publishedAt(rng, now),
        s.kind === 'FORUM' ? null : rng.pick(PERSONS),
        createHash('sha256')
          .update(title + body)
          .digest('hex'),
        pending ? 'pending' : 'published',
        forcePrivate ? tenantId['demo-republic'] : null,
        topicId.get(topic),
        geo,
        sent.label,
        sent.score,
        Math.round(120 + rng.next() ** 2 * 18000),
      ]);
      textRows.push([id, body]);
      for (const pid of new Set([rng.pick(personIds), rng.pick(personIds)].slice(0, rng.int(0, 2))))
        entRows.push([id, pid, rng.int(1, 4)]);
      for (const oid of new Set([rng.pick(orgIds), rng.pick(orgIds)].slice(0, rng.int(0, 2))))
        entRows.push([id, oid, rng.int(1, 3)]);
      if (forcePrivate) privateArticleIds.push(id);
    };

    // 88% материалов — источники края, 12% — источники республики; внутри группы — пропорционально весу источника
    const sumWeight = (list: typeof main) => list.reduce((sum, x) => sum + x.seed.weight, 0);
    for (const [group, share] of [
      [main, 0.88],
      [rep, 0.12],
    ] as const) {
      const total = sumWeight(group);
      for (const src of group) {
        const count = Math.max(4, Math.round((share * totalArticles * src.seed.weight) / total));
        for (let i = 0; i < count; i++) makeArticle(src);
      }
    }
    for (let i = 0; i < 6; i++) makeArticle(priv, true);

    await bulk(
      client,
      'articles',
      [
        'id',
        'source_id',
        'url',
        'canonical_url',
        'title',
        'lead',
        'published_at',
        'author',
        'content_hash',
        'status',
        'visibility_tenant_id',
        'topic_id',
        'geo_id',
        'sentiment_label',
        'sentiment_score',
        'views',
      ],
      artRows,
      'ON CONFLICT DO NOTHING',
    );
    await bulk(client, 'article_texts', ['article_id', 'body_text'], textRows, 'ON CONFLICT DO NOTHING');
    await bulk(
      client,
      'article_entities',
      ['article_id', 'entity_id', 'mentions'],
      entRows,
      'ON CONFLICT DO NOTHING',
    );
    await client.query(
      'UPDATE sources s SET items_count = (SELECT count(*) FROM articles a WHERE a.source_id = s.id)',
    );

    // --- слой тенанта ----------------------------------------------------------------------
    const T = tenantId['altai-krai'];
    const owner = userId['a.prokhorov@altai.media'];
    await bulk(
      client,
      'alert_rules',
      [
        'tenant_id',
        'name',
        'level',
        'keywords',
        'scope_labels',
        'channels',
        'enabled',
        'fired_count',
        'created_by',
      ],
      ALERTS.map((a) => [
        T,
        a.name,
        a.level,
        [...a.keywords],
        [...a.scope],
        [...a.channels],
        a.on,
        a.fired,
        owner,
      ]),
    );
    await bulk(
      client,
      'alert_rules',
      [
        'tenant_id',
        'name',
        'level',
        'keywords',
        'scope_labels',
        'channels',
        'enabled',
        'fired_count',
        'created_by',
      ],
      [
        [
          tenantId['demo-republic'],
          'Упоминания республики',
          'mid',
          ['республика', 'Горно-Алтайск'],
          ['Все источники'],
          ['Email'],
          true,
          2,
          userId['owner@altai-republic.demo'],
        ],
      ],
    );

    const tpl = new Map<string, string>(
      (
        await client.query<{ key: string; id: string }>(
          'SELECT key, id FROM report_templates WHERE tenant_id IS NULL',
        )
      ).rows.map((r) => [r.key, r.id]),
    );
    const day = (d: number) => new Date(now.getTime() - d * 864e5).toISOString().slice(0, 10);
    await bulk(
      client,
      'report_runs',
      [
        'tenant_id',
        'template_id',
        'name',
        'type',
        'period_from',
        'period_to',
        'status',
        'format',
        'size_bytes',
        'error',
        'created_by',
        'created_at',
      ],
      [
        [
          T,
          tpl.get('mediametrics'),
          'Медиаметрия Алтайского края · сентябрь 2026',
          'Медиаметрия',
          day(30),
          day(1),
          'completed',
          'pdf',
          2_400_000,
          null,
          owner,
          ago(60 * 24 * 2),
        ],
        [
          T,
          tpl.get('industry'),
          'ТЭК: мониторинг цен на топливо',
          'Отраслевой',
          day(7),
          day(0),
          'completed',
          'xlsx',
          480_000,
          null,
          owner,
          ago(60 * 24),
        ],
        [
          T,
          tpl.get('persons'),
          'Упоминания персон за квартал',
          'NER-анализ',
          day(90),
          day(0),
          'running',
          null,
          null,
          null,
          owner,
          ago(10),
        ],
        [
          T,
          tpl.get('auto_review'),
          'Дайджест агросектора (неделя)',
          'Автообзор',
          day(14),
          day(7),
          'completed',
          'pdf',
          1_100_000,
          null,
          owner,
          ago(60 * 24 * 7),
        ],
        [
          T,
          tpl.get('sources'),
          'Сравнение региональных СМИ',
          'Источники',
          day(60),
          day(30),
          'failed',
          null,
          null,
          'Недостаточно данных по источнику «Бийский рабочий»',
          owner,
          ago(60 * 24 * 3),
        ],
      ],
    );

    await bulk(
      client,
      'payments',
      [
        'tenant_id',
        'provider',
        'description',
        'method_label',
        'amount_minor',
        'status',
        'created_at',
        'paid_at',
      ],
      [
        [
          T,
          'test',
          'Тариф PRO · продление на 1 месяц',
          'Карта ••4521',
          1_990_000,
          'paid',
          ago(60 * 24 * 16),
          ago(60 * 24 * 16),
        ],
        [
          T,
          'test',
          'Тариф PRO · продление на 1 месяц',
          'Счёт для юрлица',
          1_990_000,
          'paid',
          ago(60 * 24 * 46),
          ago(60 * 24 * 46),
        ],
        [
          T,
          'test',
          'Тариф PRO · продление на 1 месяц',
          'Карта ••4521',
          1_990_000,
          'paid',
          ago(60 * 24 * 77),
          ago(60 * 24 * 77),
        ],
        [
          T,
          'test',
          'Доп. пакет: 100k AI-токенов',
          'Карта ••4521',
          320_000,
          'refunded',
          ago(60 * 24 * 90),
          ago(60 * 24 * 90),
        ],
      ],
    );

    await bulk(
      client,
      'notifications',
      ['tenant_id', 'level', 'title', 'body', 'created_at'],
      [
        [T, 'crit', 'Критический сюжет: рост цен на ДТ в южных районах', '8 материалов за час', ago(12)],
        [
          T,
          'warn',
          'Парсер biysk22.ru: 6 неудачных попыток подряд',
          'Проверьте селекторы или антибот-защиту',
          ago(60),
        ],
        [T, 'info', 'Отчёт «Медиаметрия · сентябрь» готов', 'PDF, 2,4 МБ', ago(180)],
        [T, 'info', 'AI-дискавери нашёл 34 новых кандидата', 'Требуется модерация', ago(60 * 24)],
      ],
    );

    await bulk(
      client,
      'saved_filters',
      ['tenant_id', 'user_id', 'name', 'filter', 'visibility'],
      [
        [
          T,
          owner,
          'Негатив по топливу',
          JSON.stringify({ topics: ['fuel'], sentiment: ['NG', 'VN'] }),
          'team',
        ],
        [
          T,
          userId['m.kovaleva@altai.media'],
          'Агро: позитив',
          JSON.stringify({ topics: ['agro'], sentiment: ['P', 'VP'] }),
          'private',
        ],
      ],
    );

    // --- тенант «Республика Алтай»: небольшой, но непустой набор данных --------------------------------
    const R = tenantId['demo-republic'];
    const rOwner = userId['owner@altai-republic.demo'];
    await bulk(
      client,
      'notifications',
      ['tenant_id', 'level', 'title', 'body', 'created_at'],
      [
        [R, 'info', 'Добро пожаловать в МедиаРадар', 'Подключены 3 источника республики', ago(60 * 24 * 5)],
        [
          R,
          'warn',
          'Источник «Эл-Алтай (демо)» отвечает медленно',
          'Среднее время ответа выросло втрое',
          ago(95),
        ],
      ],
    );
    await bulk(
      client,
      'saved_filters',
      ['tenant_id', 'user_id', 'name', 'filter', 'visibility'],
      [[R, rOwner, 'Госуправление', JSON.stringify({ topics: ['gov'] }), 'team']],
    );
    await bulk(
      client,
      'report_runs',
      [
        'tenant_id',
        'template_id',
        'name',
        'type',
        'period_from',
        'period_to',
        'status',
        'format',
        'size_bytes',
        'created_by',
        'created_at',
      ],
      [
        [
          R,
          tpl.get('mediametrics'),
          'Медиаметрия республики · неделя',
          'Медиаметрия',
          day(7),
          day(0),
          'completed',
          'pdf',
          900_000,
          rOwner,
          ago(60 * 24),
        ],
      ],
    );
    await bulk(
      client,
      'payments',
      [
        'tenant_id',
        'provider',
        'description',
        'method_label',
        'amount_minor',
        'status',
        'created_at',
        'paid_at',
      ],
      [
        [
          R,
          'test',
          'Тариф STARTER · продление на 1 месяц',
          'Карта ••1188',
          490_000,
          'paid',
          ago(60 * 24 * 5),
          ago(60 * 24 * 5),
        ],
      ],
    );

    // --- собственные темы тенантов (поверх системного пресета) ---------------------------------
    await bulk(
      client,
      'topics',
      ['tenant_id', 'key', 'name', 'color', 'sort'],
      [
        [T, 'tourism', 'Туризм (Белокуриха, Чарыш)', '#14b8a6', 100],
        [R, 'tourism', 'Туризм и экология Горного Алтая', '#14b8a6', 100],
      ],
    );

    // --- настройки и аудит (только для демо/разработки!) ---------------------------------------
    await bulk(
      client,
      'settings',
      ['key', 'scope_type', 'scope_id', 'tenant_id', 'value'],
      [
        ['auth.registration.open', 'platform', null, null, 'true'],
        ['auth.mfa.enforceForAdmins', 'platform', null, null, 'false'],
        ['portal.public.enabled', 'tenant', T, T, 'true'],
        ['portal.public.enabled', 'tenant', R, R, 'false'],
      ],
    );
    const note = JSON.stringify({ note: 'Демо-данные: для разработки, не для production' });
    await client.query(
      `INSERT INTO audit_log (tenant_id, actor_type, action, object_type, after) VALUES ($1, 'system', 'seed.demo', 'tenant', $3), ($2, 'system', 'seed.demo', 'tenant', $3)`,
      [T, R, note],
    );
    await client.query('COMMIT');

    return {
      tenants: tenantId,
      users: userId,
      sources: allSources.length,
      articles: artRows.length,
      privateArticleIds,
      sharedSourceIds: main.filter((s) => s.seed.sharedWithRepublic).map((s) => s.id),
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}
