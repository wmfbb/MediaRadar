import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/client';
import { apiDb, loadIds, withAdmin, workerDb, type Ids } from './helpers';

/**
 * Классификация ВСЕХ таблиц схемы public. Новая таблица без классификации роняет тест:
 * разработчик обязан осознанно выбрать модель изоляции (см. docs/DATA_MODEL.md §4).
 */
const TENANT_SCOPED = [
  'memberships', 'invitations', 'api_keys', 'audit_log', 'settings', 'settings_history', 'topics', 'roles',
  'tenant_sources', 'alert_rules', 'report_templates', 'report_runs', 'subscriptions', 'payments', 'saved_filters', 'notifications',
];
/** Таблицы, где tenant_id IS NULL означает «общая/системная строка». */
const NULLABLE_TENANT = ['audit_log', 'settings', 'settings_history', 'topics', 'roles', 'report_templates'];
const APPEND_ONLY = ['audit_log', 'settings_history'];
const OTHER = {
  root: ['tenants'],
  inherited: ['role_permissions'],
  userScoped: ['users', 'sessions', 'user_recovery_codes', 'password_resets'],
  sharedContent: ['sources', 'source_configs', 'articles', 'article_texts', 'article_entities'],
  globalReference: ['geo_places', 'entities', 'plans', 'feature_flags', 'schema_migrations'],
};
const ALL_CLASSIFIED = new Set([...TENANT_SCOPED, ...Object.values(OTHER).flat()]);

let api: Db;
let worker: Db;
let ids: Ids;

beforeAll(async () => {
  api = apiDb();
  worker = workerDb();
  ids = await loadIds();
  // «канарейки»: по строке для каждого тенанта там, где демо-данные пусты, — чтобы проверки не были вакуумными
  await withAdmin(async (c) => {
    const role = (await c.query<{ id: string }>("SELECT id FROM roles WHERE key = 'VIEWER' AND tenant_id IS NULL")).rows[0]!.id;
    for (const [t, owner] of [[ids.tenantA, ids.users['a.prokhorov@altai.media']], [ids.tenantB, ids.users['owner@altai-republic.demo']]] as const) {
      await c.query("INSERT INTO invitations (tenant_id, email, role_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day') ON CONFLICT DO NOTHING", [t, `inv-${t.slice(0, 8)}@x.ru`, role, `inv-hash-${t}`]);
      await c.query("INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, created_by) VALUES ($1, 'canary', 'mr_x', $2, $3) ON CONFLICT DO NOTHING", [t, `key-hash-${t}`, owner]);
      await c.query("INSERT INTO roles (tenant_id, key, name) VALUES ($1, 'CUSTOM_CANARY', 'Кастомная') ON CONFLICT DO NOTHING", [t]);
      await c.query("INSERT INTO report_templates (tenant_id, key, name) VALUES ($1, 'canary', 'Канарейка') ON CONFLICT DO NOTHING", [t]);
      await c.query("INSERT INTO settings_history (key, scope_type, scope_id, tenant_id, new_value, version) VALUES ('content.excerpt.maxChars', 'tenant', $1, $1, '500', 1)", [t]);
    }
  });
});
afterAll(async () => {
  await api.close();
  await worker.close();
});

describe('классификация схемы', () => {
  it('каждая таблица public классифицирована', async () => {
    const tables = await withAdmin((c) => c.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'"));
    const unclassified = tables.rows.map((r) => r.tablename).filter((t) => !ALL_CLASSIFIED.has(t));
    expect(unclassified, 'Новые таблицы нужно добавить в классификацию и защитить RLS').toEqual([]);
  });

  it('все таблицы, кроме глобальных справочников, имеют включённый и принудительный RLS и политики', async () => {
    const r = await withAdmin((c) => c.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`));
    for (const row of r.rows) {
      if (OTHER.globalReference.includes(row.relname)) continue;
      expect(row.relrowsecurity, `${row.relname}: RLS выключен`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname}: FORCE RLS выключен`).toBe(true);
      expect(row.policies, `${row.relname}: нет политик`).toBeGreaterThan(0);
    }
  });

  it('любая таблица с колонкой tenant_id входит в список тенантных', async () => {
    const r = await withAdmin((c) => c.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id'"));
    // sessions.tenant_id — «активный тенант сессии», изоляция там по владельцу-пользователю, а не по тенанту
    const EXCEPTIONS = ['sessions'];
    for (const { table_name } of r.rows) if (!EXCEPTIONS.includes(table_name)) expect(TENANT_SCOPED, table_name).toContain(table_name);
  });

  it('прикладные роли: не суперпользователь, без BYPASSRLS, не владельцы таблиц', async () => {
    const r = await withAdmin((c) => c.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('app_api', 'app_worker')"));
    expect(r.rows).toHaveLength(2);
    for (const role of r.rows) {
      expect(role.rolsuper, role.rolname).toBe(false);
      expect(role.rolbypassrls, role.rolname).toBe(false);
    }
    const owned = await withAdmin((c) => c.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner IN ('app_api', 'app_worker')"));
    expect(owned.rowCount).toBe(0);
  });
});

describe.each(TENANT_SCOPED)('изоляция тенантов: %s', (table) => {
  const appendOnly = APPEND_ONLY.includes(table);
  const nullable = NULLABLE_TENANT.includes(table);

  it('данные есть у обоих тенантов (проверка не вакуумна)', async () => {
    const r = await withAdmin((c) => c.query<{ a: number; b: number }>(
      `SELECT count(*) FILTER (WHERE tenant_id = $1)::int AS a, count(*) FILTER (WHERE tenant_id = $2)::int AS b FROM ${table}`, [ids.tenantA, ids.tenantB]));
    expect(r.rows[0]!.a).toBeGreaterThan(0);
    expect(r.rows[0]!.b).toBeGreaterThan(0);
  });

  it('тенант A видит только свои строки (и системные, если допустимо)', async () => {
    await api.tenant({ tenantId: ids.tenantA }, async (q) => {
      const foreign = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id IS NOT NULL AND tenant_id <> $1`, [ids.tenantA]);
      expect(foreign.rows[0]!.n).toBe(0);
      const own = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [ids.tenantA]);
      expect(own.rows[0]!.n).toBeGreaterThan(0);
      if (!nullable) {
        const nulls = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id IS NULL`);
        expect(nulls.rows[0]!.n).toBe(0);
      }
    }, { readOnly: true });
  });

  it('тенант B не видит строки A', async () => {
    await api.tenant({ tenantId: ids.tenantB }, async (q) => {
      const r = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [ids.tenantA]);
      expect(r.rows[0]!.n).toBe(0);
    }, { readOnly: true });
  });

  it('без контекста тенанта строки тенантов не видны', async () => {
    const r = await api.raw((q) => q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id IS NOT NULL`));
    expect(r.rows[0]!.n).toBe(0);
  });

  if (!appendOnly) {
    it('тенант B не может изменить или удалить строки A', async () => {
      await api.tenant({ tenantId: ids.tenantB }, async (q) => {
        const upd = await q.query(`UPDATE ${table} SET tenant_id = tenant_id WHERE tenant_id = $1`, [ids.tenantA]);
        expect(upd.rowCount).toBe(0);
        const del = await q.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [ids.tenantA]);
        expect(del.rowCount).toBe(0);
      });
      const still = await withAdmin((c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [ids.tenantA]));
      expect(still.rows[0]!.n).toBeGreaterThan(0);
    });

    it('тенант B не может «перебросить» свою строку в тенант A (WITH CHECK)', async () => {
      await expect(api.tenant({ tenantId: ids.tenantB }, (q) => q.query(`UPDATE ${table} SET tenant_id = $1 WHERE tenant_id = $2`, [ids.tenantA, ids.tenantB])))
        .rejects.toThrow(/row-level security|violates|не может|duplicate key/i);
    });
  }

  it('тенант B не может вставить строку с tenant_id тенанта A', async () => {
    const row = await withAdmin((c) => c.query<{ j: Record<string, unknown> }>(`SELECT to_jsonb(t) AS j FROM ${table} t WHERE t.tenant_id = $1 LIMIT 1`, [ids.tenantA]));
    const payload = JSON.stringify(row.rows[0]!.j);
    await expect(api.tenant({ tenantId: ids.tenantB }, (q) => q.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`, [payload])))
      .rejects.toThrow(/row-level security/i);
  });

  it('платформенный администратор видит данные обоих тенантов', async () => {
    await api.platform(ids.users['admin@mediaradar.local']!, async (q) => {
      const r = await q.query<{ a: number; b: number }>(
        `SELECT count(*) FILTER (WHERE tenant_id = $1)::int AS a, count(*) FILTER (WHERE tenant_id = $2)::int AS b FROM ${table}`, [ids.tenantA, ids.tenantB]);
      expect(r.rows[0]!.a).toBeGreaterThan(0);
      expect(r.rows[0]!.b).toBeGreaterThan(0);
    }, { readOnly: true });
  });
});

describe('общий слой контента: источники и материалы', () => {
  let tass: string, privSrc: string, repSrc: string, altSrc: string;
  beforeAll(async () => {
    const r = await withAdmin((c) => c.query<{ domain: string; id: string }>('SELECT domain, id FROM sources'));
    const id = (d: string) => r.rows.find((x) => x.domain === d)!.id;
    tass = id('tass.ru'); privSrc = id('private-feed.example'); repSrc = id('altai-republic.ru'); altSrc = id('katun24.ru');
  });

  const countFor = (tenantId: string, sql: string, params: unknown[] = []) =>
    api.tenant({ tenantId }, async (q) => (await q.query<{ n: number }>(sql, params)).rows[0]!.n, { readOnly: true });

  it('тенант видит только подписанные источники и свои приватные', async () => {
    const aDomains = await api.tenant({ tenantId: ids.tenantA }, async (q) => (await q.query<{ domain: string }>('SELECT domain FROM sources')).rows.map((r) => r.domain), { readOnly: true });
    expect(aDomains).toContain('katun24.ru');
    expect(aDomains).toContain('tass.ru');
    expect(aDomains).not.toContain('altai-republic.ru');
    expect(aDomains).not.toContain('private-feed.example');
    const bDomains = await api.tenant({ tenantId: ids.tenantB }, async (q) => (await q.query<{ domain: string }>('SELECT domain FROM sources')).rows.map((r) => r.domain), { readOnly: true });
    expect(bDomains).toContain('altai-republic.ru');
    expect(bDomains).toContain('private-feed.example');
    expect(bDomains).toContain('tass.ru'); // общий источник: оба тенанта подписаны
    expect(bDomains).not.toContain('katun24.ru');
  });

  it('число видимых материалов = числу материалов подписанных источников (+ приватные своего тенанта)', async () => {
    for (const [tenant, label] of [[ids.tenantA, 'A'], [ids.tenantB, 'B']] as const) {
      const expected = await withAdmin(async (c) => (await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM articles a WHERE (a.visibility_tenant_id IS NULL AND a.source_id IN (SELECT source_id FROM tenant_sources WHERE tenant_id = $1 AND enabled)) OR a.visibility_tenant_id = $1`, [tenant])).rows[0]!.n);
      const visible = await countFor(tenant, 'SELECT count(*)::int AS n FROM articles');
      expect(visible, `тенант ${label}`).toBe(expected);
      expect(visible).toBeGreaterThan(0);
    }
  });

  it('приватные материалы тенанта B недоступны тенанту A и доступны B', async () => {
    const privIds = await withAdmin(async (c) => (await c.query<{ id: string }>('SELECT id FROM articles WHERE visibility_tenant_id IS NOT NULL')).rows.map((r) => r.id));
    expect(privIds.length).toBeGreaterThan(0);
    expect(await countFor(ids.tenantA, 'SELECT count(*)::int AS n FROM articles WHERE id = ANY($1)', [privIds])).toBe(0);
    expect(await countFor(ids.tenantB, 'SELECT count(*)::int AS n FROM articles WHERE id = ANY($1)', [privIds])).toBe(privIds.length);
    expect(await countFor(ids.tenantA, 'SELECT count(*)::int AS n FROM articles WHERE source_id = $1', [privSrc])).toBe(0);
  });

  it('общий источник: материалы tass.ru видны обоим тенантам', async () => {
    const a = await countFor(ids.tenantA, 'SELECT count(*)::int AS n FROM articles WHERE source_id = $1', [tass]);
    const b = await countFor(ids.tenantB, 'SELECT count(*)::int AS n FROM articles WHERE source_id = $1', [tass]);
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(a);
  });

  it('материалы чужих источников недоступны (A не видит республику, B не видит край)', async () => {
    expect(await countFor(ids.tenantA, 'SELECT count(*)::int AS n FROM articles WHERE source_id = $1', [repSrc])).toBe(0);
    expect(await countFor(ids.tenantB, 'SELECT count(*)::int AS n FROM articles WHERE source_id = $1', [altSrc])).toBe(0);
  });

  it('тексты, связи с сущностями и конфиги наследуют видимость материала/источника', async () => {
    expect(await countFor(ids.tenantA, 'SELECT count(*)::int AS n FROM article_texts t WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.id = t.article_id)')).toBe(0);
    expect(await countFor(ids.tenantA, 'SELECT count(*)::int AS n FROM article_texts')).toBe(await countFor(ids.tenantA, 'SELECT count(*)::int AS n FROM articles'));
    expect(await countFor(ids.tenantA, 'SELECT count(*)::int AS n FROM article_entities WHERE article_id IN (SELECT id FROM articles WHERE visibility_tenant_id IS NOT NULL)')).toBe(0);
    expect(await countFor(ids.tenantA, 'SELECT count(*)::int AS n FROM source_configs WHERE source_id = $1', [repSrc])).toBe(0);
    expect(await countFor(ids.tenantB, 'SELECT count(*)::int AS n FROM source_configs WHERE source_id = $1', [repSrc])).toBe(1);
  });

  it('API не может писать в общий слой: нет глобальных материалов, нельзя менять общие источники', async () => {
    await expect(api.tenant({ tenantId: ids.tenantA }, (q) => q.query(
      `INSERT INTO articles (source_id, url, canonical_url, title, published_at) VALUES ($1, 'https://x/1', 'https://x/1', 'Подмена', now())`, [altSrc]))).rejects.toThrow(/row-level security/i);
    const upd = await api.tenant({ tenantId: ids.tenantA }, (q) => q.query("UPDATE sources SET name = 'Взлом' WHERE owner_tenant_id IS NULL"));
    expect(upd.rowCount).toBe(0);
    const del = await api.tenant({ tenantId: ids.tenantA }, (q) => q.query('DELETE FROM sources WHERE owner_tenant_id IS NULL'));
    expect(del.rowCount).toBe(0);
  });

  it('API может создать приватный материал только в своём тенанте', async () => {
    await expect(api.tenant({ tenantId: ids.tenantB }, async (q) => {
      await q.query(`INSERT INTO articles (source_id, url, canonical_url, title, published_at, visibility_tenant_id) VALUES ($1, 'https://p/1', 'https://p/1', 'Мой', now(), $2)`, [privSrc, ids.tenantB]);
      throw new Error('rollback-ok');
    })).rejects.toThrow('rollback-ok'); // вставка прошла, откатили вручную
    await expect(api.tenant({ tenantId: ids.tenantA }, (q) => q.query(
      `INSERT INTO articles (source_id, url, canonical_url, title, published_at, visibility_tenant_id) VALUES ($1, 'https://p/2', 'https://p/2', 'Чужой', now(), $2)`, [privSrc, ids.tenantB]))).rejects.toThrow(/row-level security/i);
  });

  it('роль воркера пишет в общий слой (сбор данных)', async () => {
    await expect(worker.raw(async (q) => {
      await q.query(`INSERT INTO articles (source_id, url, canonical_url, title, published_at) VALUES ($1, 'https://w/1', 'https://w/1', 'Сбор', now())`, [altSrc]);
      const r = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM articles');
      expect(r.rows[0]!.n).toBeGreaterThan(500);
      throw new Error('rollback-ok');
    })).rejects.toThrow('rollback-ok');
  });
});

describe('идентичность: пользователи, сессии, тенанты, членство', () => {
  const emails = (tenantId: string | null, userId?: string) =>
    (tenantId
      ? api.tenant({ tenantId, userId }, async (q) => (await q.query<{ email: string }>('SELECT email FROM users')).rows.map((r) => r.email), { readOnly: true })
      : api.raw(async (q) => (await q.query<{ email: string }>('SELECT email FROM users')).rows.map((r) => r.email)));

  it('в контексте тенанта виден только состав этого тенанта', async () => {
    const a = await emails(ids.tenantA);
    expect(a).toContain('a.prokhorov@altai.media');
    expect(a).not.toContain('owner@altai-republic.demo');
    expect(a).not.toContain('admin@mediaradar.local');
    const b = await emails(ids.tenantB);
    expect(b.sort()).toEqual(['m.kovaleva@altai.media', 'owner@altai-republic.demo']);
  });

  it('без контекста пользователи не видны; в системном контексте (вход) видны все', async () => {
    expect(await emails(null)).toEqual([]);
    const all = await api.system(async (q) => (await q.query('SELECT 1 FROM users')).rowCount);
    expect(all).toBe(9);
  });

  it('пользователь видит свои членства во всех тенантах, но чужих — нет', async () => {
    const maria = ids.users['m.kovaleva@altai.media']!;
    const mine = await api.tenant({ tenantId: ids.tenantB, userId: maria }, async (q) => (await q.query<{ tenant_id: string }>('SELECT tenant_id FROM memberships WHERE user_id = $1', [maria])).rows.map((r) => r.tenant_id), { readOnly: true });
    expect(mine.sort()).toEqual([ids.tenantA, ids.tenantB].sort());
    const foreign = await api.tenant({ tenantId: ids.tenantB, userId: maria }, async (q) => (await q.query('SELECT 1 FROM memberships WHERE user_id = $1', [ids.users['a.prokhorov@altai.media']])).rowCount, { readOnly: true });
    expect(foreign).toBe(0);
    const slugs = await api.tenant({ tenantId: ids.tenantB, userId: maria }, async (q) => (await q.query<{ slug: string }>('SELECT slug FROM tenants')).rows.map((r) => r.slug), { readOnly: true });
    expect(slugs.sort()).toEqual(['altai-krai', 'demo-republic']);
    const alex = await api.tenant({ tenantId: ids.tenantA, userId: ids.users['a.prokhorov@altai.media'] }, async (q) => (await q.query<{ slug: string }>('SELECT slug FROM tenants')).rows.map((r) => r.slug), { readOnly: true });
    expect(alex).toEqual(['altai-krai']);
  });

  it('тенант не может создать тенант или добавить участника в чужой тенант', async () => {
    await expect(api.tenant({ tenantId: ids.tenantA }, (q) => q.query("INSERT INTO tenants (slug, name) VALUES ('evil-tenant', 'Evil')"))).rejects.toThrow(/row-level security/i);
    const role = await withAdmin(async (c) => (await c.query<{ id: string }>("SELECT id FROM roles WHERE key = 'OWNER' AND tenant_id IS NULL")).rows[0]!.id);
    await expect(api.tenant({ tenantId: ids.tenantA }, (q) => q.query('INSERT INTO memberships (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [ids.tenantB, ids.users['d.esin@altai.media'], role]))).rejects.toThrow(/row-level security/i);
  });

  it('сессии: пользователь видит только свои', async () => {
    const [alex, maria] = [ids.users['a.prokhorov@altai.media']!, ids.users['m.kovaleva@altai.media']!];
    await withAdmin(async (c) => {
      for (const [u, h] of [[alex, 'sess-alex'], [maria, 'sess-maria']] as const)
        await c.query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day') ON CONFLICT DO NOTHING", [u, h]);
    });
    const seen = await api.tenant({ tenantId: ids.tenantA, userId: alex }, async (q) => (await q.query<{ token_hash: string }>('SELECT token_hash FROM sessions')).rows.map((r) => r.token_hash), { readOnly: true });
    expect(seen).toContain('sess-alex');
    expect(seen).not.toContain('sess-maria');
    expect(await api.raw(async (q) => (await q.query('SELECT 1 FROM sessions')).rowCount)).toBe(0);
  });

  it('роли: системные видны всем, кастомные — только своему тенанту; системные нельзя менять', async () => {
    const keys = (tenantId: string) => api.tenant({ tenantId }, async (q) => (await q.query<{ key: string; tenant_id: string | null }>('SELECT key, tenant_id FROM roles')).rows, { readOnly: true });
    const a = await keys(ids.tenantA);
    expect(a.filter((r) => r.tenant_id === null)).toHaveLength(6);
    expect(a.filter((r) => r.tenant_id === ids.tenantB)).toHaveLength(0);
    const upd = await api.tenant({ tenantId: ids.tenantA }, (q) => q.query("UPDATE roles SET name = 'Взлом' WHERE tenant_id IS NULL"));
    expect(upd.rowCount).toBe(0);
    const perms = await api.tenant({ tenantId: ids.tenantA }, async (q) => (await q.query('SELECT 1 FROM role_permissions')).rowCount, { readOnly: true });
    expect(perms).toBeGreaterThan(50);
    await expect(api.tenant({ tenantId: ids.tenantA }, (q) => q.query(
      "INSERT INTO role_permissions (role_id, permission) SELECT id, 'billing:manage' FROM roles WHERE key = 'VIEWER' AND tenant_id IS NULL"))).rejects.toThrow(/row-level security/i);
  });
});

describe('права прикладных ролей и журналы', () => {
  it('API не пишет в справочники и не трогает schema_migrations', async () => {
    for (const sql of [
      "INSERT INTO plans (key, name) VALUES ('hack', 'Hack')",
      "UPDATE feature_flags SET enabled = true",
      "DELETE FROM geo_places",
      "INSERT INTO entities (type, canonical_name) VALUES ('person', 'X')",
      'SELECT * FROM schema_migrations',
    ])
      await expect(api.tenant({ tenantId: ids.tenantA }, (q) => q.query(sql)), sql).rejects.toThrow(/permission denied/i);
  });

  it('аудит и история настроек: нельзя изменить или удалить даже владельцу БД; прикладным ролям нет прав', async () => {
    await expect(withAdmin((c) => c.query("UPDATE audit_log SET action = 'x'"))).rejects.toThrow(/append-only/);
    await expect(withAdmin((c) => c.query('DELETE FROM audit_log'))).rejects.toThrow(/append-only/);
    await expect(withAdmin((c) => c.query('TRUNCATE audit_log'))).rejects.toThrow(/append-only/);
    for (const t of APPEND_ONLY) {
      await expect(api.tenant({ tenantId: ids.tenantA }, (q) => q.query(`UPDATE ${t} SET tenant_id = tenant_id`)), t).rejects.toThrow(/permission denied/i);
      await expect(api.tenant({ tenantId: ids.tenantA }, (q) => q.query(`DELETE FROM ${t}`)), t).rejects.toThrow(/permission denied/i);
    }
    await api.tenant({ tenantId: ids.tenantA }, (q) => q.query("INSERT INTO audit_log (tenant_id, action) VALUES ($1, 'test.event')", [ids.tenantA]));
    await expect(api.tenant({ tenantId: ids.tenantA }, (q) => q.query("INSERT INTO audit_log (tenant_id, action) VALUES ($1, 'test.forged')", [ids.tenantB]))).rejects.toThrow(/row-level security/i);
  });

  it('удаление тенанта не затрагивает журнал аудита', async () => {
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      try {
        const t = (await c.query<{ id: string }>("INSERT INTO tenants (slug, name) VALUES ('tmp-tenant', 'Временный') RETURNING id")).rows[0]!.id;
        await c.query("INSERT INTO audit_log (tenant_id, action) VALUES ($1, 'tmp.event')", [t]);
        await c.query('DELETE FROM tenants WHERE id = $1', [t]);
        const left = await c.query("SELECT 1 FROM audit_log WHERE action = 'tmp.event'");
        expect(left.rowCount).toBe(1);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });

  it('uuid_generate_v7(): версия 7, время ≈ сейчас, монотонность по миллисекундам', async () => {
    const r = await withAdmin((c) => c.query<{ id: string; ms: number }>(
      "SELECT id, ('x' || substr(replace(id::text, '-', ''), 1, 12))::bit(48)::bigint::float8 AS ms FROM (SELECT uuid_generate_v7() AS id) s"));
    const { id, ms } = r.rows[0]!;
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]!);
    expect(Math.abs(ms - Date.now())).toBeLessThan(60_000);
  });
});
