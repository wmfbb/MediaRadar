import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, PASSWORD, createTestApp, loginAs, setPlatformSetting, tenantIds, withAdmin, type TestCtx } from './helpers';

let ctx: TestCtx;
let owner: Client;
let admin: Client;
let viewer: Client;
let superAdmin: Client;
let tenants: { A: string; B: string };
interface Item { key: string; value: unknown; from: string; editableScopes: string[]; levels: Record<string, { value: unknown; version: number }>; default: unknown }
const items = (body: { groups: Array<{ items: Item[] }> }) => body.groups.flatMap((g) => g.items);

beforeAll(async () => {
  ctx = await createTestApp();
  [owner, admin, viewer, superAdmin] = await Promise.all([
    loginAs(ctx, 'a.prokhorov@altai.media'), loginAs(ctx, 'n.sergeeva@altai.media'), loginAs(ctx, 'i.lapteva@agro22.ru'), loginAs(ctx, 'admin@mediaradar.local'),
  ]);
  tenants = await tenantIds();
});
afterAll(async () => {
  await withAdmin((c) => c.query("DELETE FROM settings WHERE key IN ('moderation.mode', 'retention.rawHtmlDays', 'ui.theme.default', 'alerts.dedupeWindowMin', 'schedule.minIntervalSec')"));
  await ctx.close();
});

const put = (c: Client, key: string, body: object) => c.put(`/v1/settings/${key}`, body);

describe('реестр настроек: чтение и права', () => {
  it('владелец и администратор видят сгруппированные настройки, редактируемые уровни зависят от роли', async () => {
    const o = (await owner.get('/v1/settings')).json();
    expect(o.view).toBe('tenant');
    expect(o.groups.map((g: { id: string }) => g.id)).toContain('content');
    const find = (list: Item[], k: string) => list.find((i) => i.key === k)!;
    expect(find(items(o), 'content.policy.default.GOV_PORTAL').editableScopes).toContain('tenant');
    const a = items((await admin.get('/v1/settings')).json());
    expect(find(a, 'content.policy.default.GOV_PORTAL').editableScopes).not.toContain('tenant'); // нужно tenant:settings
    expect(find(a, 'moderation.mode').editableScopes).toContain('tenant'); // достаточно tenant:settings_basic
    expect(items(o).every((i) => !i.editableScopes.includes('platform'))).toBe(true);
    expect((await viewer.get('/v1/settings')).statusCode).toBe(403);
  });
});

describe('реестр настроек: изменение', () => {
  it('изменение с версионированием, оптимистичной блокировкой, историей и откатом', async () => {
    const base = { scope: 'tenant', scopeId: tenants.A };
    expect((await put(admin, 'content.policy.override', { ...base, value: 'metadata' })).statusCode).toBe(403);
    const first = await put(admin, 'moderation.mode', { ...base, value: 'manual', reason: 'проверка' });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().version).toBe(1);
    const cur = items((await admin.get('/v1/settings')).json()).find((i) => i.key === 'moderation.mode')!;
    expect(cur).toMatchObject({ value: 'manual', from: 'tenant', default: 'auto' });
    expect(cur.levels.tenant!.version).toBe(1);
    expect((await put(admin, 'moderation.mode', { ...base, value: 'hybrid', expectedVersion: 7 })).statusCode).toBe(409);
    expect((await put(admin, 'moderation.mode', { ...base, value: 'hybrid', expectedVersion: 1 })).json().version).toBe(2);
    expect((await put(admin, 'moderation.mode', { ...base, value: 'nonsense' })).statusCode).toBe(422);
    const history = (await admin.get(`/v1/settings/moderation.mode/history?scope=tenant`)).json().items;
    expect(history.map((h: { newValue: string }) => h.newValue)).toEqual(['hybrid', 'manual']);
    expect(history[1].reason).toBe('проверка');
    expect((await admin.post(`/v1/settings/history/${history[0].id}/rollback`)).statusCode).toBe(200);
    expect(items((await admin.get('/v1/settings')).json()).find((i) => i.key === 'moderation.mode')!.value).toBe('manual');
    expect((await admin.delete(`/v1/settings/moderation.mode?scope=tenant&scopeId=${tenants.A}`)).json()).toEqual({ cleared: true });
    expect(items((await admin.get('/v1/settings')).json()).find((i) => i.key === 'moderation.mode')!.from).toBe('default');
  });

  it('недопустимые уровни и чужой тенант отклоняются; неизвестные ключи — 404', async () => {
    expect((await put(owner, 'fetch.userAgent', { scope: 'tenant', scopeId: tenants.A, value: 'Bot/1.0 test' })).statusCode).toBe(400);
    expect((await put(owner, 'moderation.mode', { scope: 'tenant', scopeId: tenants.B, value: 'manual' })).statusCode).toBe(403);
    expect((await put(owner, 'no.such.key', { scope: 'tenant', scopeId: tenants.A, value: 1 })).statusCode).toBe(404);
    expect((await put(owner, 'moderation.mode', { scope: 'platform', value: 'manual' })).statusCode).toBe(403);
    expect((await put(owner, 'schedule.minIntervalSec', { scope: 'source', scopeId: tenants.A, value: 30 })).statusCode).toBe(403);
  });

  it('изменения настроек попадают в журнал аудита', async () => {
    await put(owner, 'alerts.dedupeWindowMin', { scope: 'tenant', scopeId: tenants.A, value: 45 });
    const audit = (await owner.get('/v1/tenant/audit?action=settings.')).json().items as Array<{ action: string; objectId: string }>;
    expect(audit.some((e) => e.action === 'settings.updated' && e.objectId === 'alerts.dedupeWindowMin')).toBe(true);
  });

  it('личные настройки: любой пользователь меняет только свои; тема приходит в /me', async () => {
    const res = await put(viewer, 'ui.theme.default', { scope: 'user', value: 'dark' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await viewer.get('/v1/auth/me')).json().preferences.theme).toBe('dark');
    expect((await owner.get('/v1/auth/me')).json().preferences.theme).toBe('system'); // у других пользователей не меняется
    expect((await put(viewer, 'moderation.mode', { scope: 'tenant', scopeId: tenants.A, value: 'manual' })).statusCode).toBe(403);
    const other = (await owner.get('/v1/auth/me')).json().user.id;
    expect((await put(viewer, 'ui.theme.default', { scope: 'user', scopeId: other, value: 'light' })).statusCode).toBe(403);
  });
});

describe('реестр настроек: уровень платформы', () => {
  it('платформенный администратор меняет значение, оно наследуется тенантами, тенант перекрывает его своим', async () => {
    const view = (await superAdmin.get('/v1/settings')).json();
    expect(view.view).toBe('platform');
    const key = 'retention.rawHtmlDays';
    expect((await put(superAdmin, key, { scope: 'platform', value: 60 })).statusCode).toBe(200);
    const inherited = items((await owner.get('/v1/settings')).json()).find((i) => i.key === key)!;
    expect(inherited).toMatchObject({ value: 60, from: 'platform' });
    expect((await put(owner, key, { scope: 'tenant', scopeId: tenants.A, value: 30 })).statusCode).toBe(200);
    expect(items((await owner.get('/v1/settings')).json()).find((i) => i.key === key)!).toMatchObject({ value: 30, from: 'tenant' });
    expect(items((await new Client(ctx.app).login('owner@altai-republic.demo').then((c) => c.get('/v1/settings'))).json()).find((i) => i.key === key)!).toMatchObject({ value: 60, from: 'platform' });
    const hist = (await superAdmin.get(`/v1/settings/${key}/history?scope=platform`)).json().items;
    expect(hist[0].newValue).toBe(60);
  });

  it('открытая регистрация переключается платформенной настройкой и действует немедленно', async () => {
    const reg = (n: string) => new Client(ctx.app).post('/v1/auth/register', { email: `reg${Date.now()}${n}@example.com`, password: PASSWORD, name: 'Р', workspaceName: 'Реестр' });
    try {
      expect((await put(superAdmin, 'auth.registration.open', { scope: 'platform', value: false })).statusCode).toBe(200);
      expect((await reg('a')).statusCode).toBe(403);
      expect((await put(superAdmin, 'auth.registration.open', { scope: 'platform', value: true })).statusCode).toBe(200);
      expect((await reg('b')).statusCode).toBe(201);
    } finally {
      await setPlatformSetting('auth.registration.open', true);
    }
  });

  it('платформенные настройки не видны через тенантский просмотр как редактируемые; платформенный просмотр закрыт ролям тенанта', async () => {
    expect((await owner.get('/v1/settings?scope=platform')).statusCode).toBe(403);
    expect((await superAdmin.get(`/v1/settings/retention.rawHtmlDays/history?scope=platform`)).statusCode).toBe(200);
    expect((await owner.get(`/v1/settings/retention.rawHtmlDays/history?scope=platform`)).statusCode).toBe(403);
  });
});
