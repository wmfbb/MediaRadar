import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, PASSWORD, createTestApp, loginAs, tenantIds, withAdmin, type TestCtx } from './helpers';

let ctx: TestCtx;
let owner: Client; // OWNER, Алтайский край, тариф PRO
let ownerB: Client; // OWNER, Республика Алтай, тариф STARTER
let admin: Client;
let tenants: { A: string; B: string };
beforeAll(async () => {
  ctx = await createTestApp();
  [owner, ownerB, admin] = await Promise.all([loginAs(ctx, 'a.prokhorov@altai.media'), loginAs(ctx, 'owner@altai-republic.demo'), loginAs(ctx, 'n.sergeeva@altai.media')]);
  tenants = await tenantIds();
});
afterAll(() => ctx.close());

describe('источники', () => {
  it('реестр с показателями; статус паузы тенанта; демо-пометка', async () => {
    const r = (await owner.get('/v1/sources')).json();
    expect(r.items).toHaveLength(18);
    expect(r.kpis).toMatchObject({ total: 18, errors: 1 });
    expect(r.kpis.collected).toBeGreaterThan(300);
    const failing = r.items.find((s: { domain: string }) => s.domain === 'biysk22.ru');
    expect(failing.status).toBe('error');
    expect(failing.lastError).toMatch(/403/);
    expect(r.items.every((s: { demo: boolean }) => s.demo)).toBe(true);
    expect(r.items.find((s: { domain: string }) => s.domain === 'zarinsk.ru').status).toBe('paused');
  });

  it('карточка источника содержит активную конфигурацию и историю версий', async () => {
    const list = (await owner.get('/v1/sources')).json();
    const id = list.items.find((s: { parser: string }) => s.parser === 'PLAYWRIGHT').id;
    const s = (await owner.get(`/v1/sources/${id}`)).json();
    expect(s.config.connector).toBe('html-browser');
    expect(s.versions[0]).toMatchObject({ version: 1, isActive: true });
  });

  it('создание приватного источника: тариф STARTER не включает функцию; PRO — создаёт с конфигом и подпиской', async () => {
    const body = { name: 'Тест-источник', url: 'https://example-news.ru/', kind: 'NEWS_SITE', parser: 'RSS' };
    const denied = await ownerB.post('/v1/sources', body);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().details).toMatchObject({ reason: 'plan_feature', entitlement: 'feature.private_sources' });
    const ok = await owner.post('/v1/sources', body);
    expect(ok.statusCode, ok.body).toBe(201);
    const s = (await owner.get(`/v1/sources/${ok.json().id}`)).json();
    expect(s.isPrivate).toBe(true);
    expect(s.config.connector).toBe('rss');
    expect((await owner.post('/v1/sources', body)).statusCode).toBe(409); // тот же домен
    // изоляция: другой тенант не видит приватный источник
    expect((await ownerB.get(`/v1/sources/${ok.json().id}`)).statusCode).toBe(404);
    // отчёт о действии попал в аудит
    const audit = (await owner.get('/v1/tenant/audit?action=source.created')).json();
    expect(audit.items.length).toBeGreaterThan(0);
  });

  it('адреса внутренней сети и недопустимые схемы отклоняются (SSRF)', async () => {
    for (const url of ['http://localhost/', 'http://10.0.0.1/', 'http://169.254.169.254/', 'file:///etc/passwd', 'https://u:p@example.ru/', 'http://[::ffff:10.0.0.1]/']) {
      const res = await owner.post('/v1/sources', { name: 'Плохой', url, kind: 'NEWS_SITE', parser: 'RSS' });
      expect(res.statusCode, url).toBe(422);
    }
    expect((await owner.post('/v1/sources', { name: 'X', url: 'https://example.org', kind: 'NEWS_SITE', parser: 'RSS', cron: 'bad' })).statusCode).toBe(422);
  });

  it('пауза/возобновление подписки, запуск, версии конфига; общие источники правит только платформа', async () => {
    const list = (await owner.get('/v1/sources')).json();
    const shared = list.items.find((s: { isPrivate: boolean; domain: string }) => !s.isPrivate && s.domain === 'katun24.ru');
    expect((await owner.patch(`/v1/sources/${shared.id}`, { enabled: false })).statusCode).toBe(200);
    expect((await owner.get(`/v1/sources/${shared.id}`)).json().status).toBe('paused');
    expect((await owner.patch(`/v1/sources/${shared.id}`, { enabled: true })).statusCode).toBe(200);
    const run = await owner.post(`/v1/sources/${shared.id}/run`);
    expect(run.statusCode).toBe(202);
    expect(run.json()).toMatchObject({ implemented: false });
    expect((await owner.put(`/v1/sources/${shared.id}/config`, { config: { connector: 'rss' } })).statusCode).toBe(403);
    const priv = list.items.find((s: { isPrivate: boolean }) => s.isPrivate) ?? (await owner.get('/v1/sources')).json().items.find((s: { isPrivate: boolean }) => s.isPrivate);
    const upd = await owner.put(`/v1/sources/${priv.id}/config`, { config: { connector: 'rss', feedUrl: 'https://example-news.ru/rss' }, note: 'тест' });
    expect(upd.statusCode, upd.body).toBe(200);
    expect(upd.json().version).toBe(2);
    expect((await owner.put(`/v1/sources/${priv.id}/config`, { config: { no: 'connector' } })).statusCode).toBe(422);
    const versions = (await owner.get(`/v1/sources/${priv.id}`)).json().versions;
    expect(versions.filter((v: { isActive: boolean }) => v.isActive)).toHaveLength(1);
  });

  it('чужой источник по идентификатору недоступен', async () => {
    const other = await withAdmin(async (c) => (await c.query<{ id: string }>("SELECT id FROM sources WHERE domain = 'altai-republic.ru'")).rows[0]!.id);
    expect((await owner.get(`/v1/sources/${other}`)).statusCode).toBe(404);
    expect((await owner.patch(`/v1/sources/${other}`, { enabled: false })).statusCode).toBe(404);
    expect((await owner.post(`/v1/sources/${other}/run`)).statusCode).toBe(404);
  });
});

describe('команда: участники, роли, приглашения', () => {
  it('список участников видит только свой тенант; роли с правами', async () => {
    const members = (await owner.get('/v1/tenant/members')).json().items;
    expect(members).toHaveLength(8 - 1); // 7 членов Алтайского края (Мария состоит в обоих тенантах)
    expect(members.map((m: { email: string }) => m.email)).not.toContain('owner@altai-republic.demo');
    const roles = (await owner.get('/v1/tenant/roles')).json().items;
    expect(roles.map((r: { key: string }) => r.key)).toEqual(['OWNER', 'ADMIN', 'ANALYST', 'EDITOR', 'MODERATOR', 'VIEWER']);
    expect(roles.find((r: { key: string }) => r.key === 'VIEWER').permissions).toContain('feed:read');
  });

  it('приглашение: письмо → предпросмотр → принятие новым пользователем → вход и роль', async () => {
    const email = `invitee${Date.now()}@example.com`;
    const res = await owner.post('/v1/tenant/invitations', { email, roleKey: 'ANALYST' });
    expect(res.statusCode, res.body).toBe(201);
    const mail = ctx.mailer.last()!;
    expect(mail.to).toBe(email);
    const token = /token=([\w-]+)/.exec(mail.text)![1]!;
    const anon = new Client(ctx.app);
    const preview = (await anon.get(`/v1/auth/invitations/${token}`)).json();
    expect(preview).toMatchObject({ email, tenantName: 'Алтайский край', roleName: 'Аналитик', accountExists: false });
    expect((await anon.post('/v1/auth/invitations/accept', { token })).statusCode).toBe(422); // нужны имя и пароль
    expect((await anon.post('/v1/auth/invitations/accept', { token, name: 'Новый Аналитик', password: 'short' })).statusCode).toBe(422);
    expect((await anon.post('/v1/auth/invitations/accept', { token, name: 'Новый Аналитик', password: PASSWORD })).statusCode).toBe(200);
    const me = (await anon.get('/v1/auth/me')).json();
    expect(me.role.key).toBe('ANALYST');
    expect(me.tenant.slug).toBe('altai-krai');
    expect((await new Client(ctx.app).get(`/v1/auth/invitations/${token}`)).statusCode).toBe(404); // токен одноразовый
  });

  it('приглашение существующего пользователя требует входа под его аккаунтом', async () => {
    const res = await ownerB.post('/v1/tenant/invitations', { email: 'a.prokhorov@altai.media', roleKey: 'VIEWER' });
    expect(res.statusCode, res.body).toBe(201);
    const token = /token=([\w-]+)/.exec(ctx.mailer.last()!.text)![1]!;
    expect((await new Client(ctx.app).post('/v1/auth/invitations/accept', { token })).statusCode).toBe(401);
    expect((await owner.post('/v1/auth/invitations/accept', { token })).statusCode).toBe(200);
    expect((await owner.get('/v1/auth/me')).json().tenants).toHaveLength(2);
    await withAdmin((c) => c.query('DELETE FROM memberships WHERE tenant_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)', [tenants.B, 'a.prokhorov@altai.media']));
    await owner.post('/v1/auth/switch-tenant', { tenantId: tenants.A });
  });

  it('лимит мест по тарифу: STARTER допускает 3 пользователя', async () => {
    const r1 = await ownerB.post('/v1/tenant/invitations', { email: `seat1-${Date.now()}@example.com`, roleKey: 'VIEWER' });
    expect(r1.statusCode, r1.body).toBe(201); // 2 участника + 1 приглашение = 3
    const r2 = await ownerB.post('/v1/tenant/invitations', { email: `seat2-${Date.now()}@example.com`, roleKey: 'VIEWER' });
    expect(r2.statusCode).toBe(403);
    expect(r2.json().details).toMatchObject({ reason: 'plan_limit', entitlement: 'seats' });
    const pending = (await ownerB.get('/v1/tenant/invitations')).json().items;
    for (const inv of pending) expect((await ownerB.delete(`/v1/tenant/invitations/${inv.id}`)).statusCode).toBe(200);
  });

  it('правила смены ролей: нельзя себя, ADMIN не трогает владельца и не назначает владельцев', async () => {
    const members = (await owner.get('/v1/tenant/members')).json().items as Array<{ id: string; email: string; roleKey: string }>;
    const me = members.find((m) => m.email === 'a.prokhorov@altai.media')!;
    const analyst = members.find((m) => m.email === 'm.kovaleva@altai.media')!;
    expect((await owner.patch(`/v1/tenant/members/${me.id}`, { roleKey: 'VIEWER' })).statusCode).toBe(403); // себя нельзя
    expect((await owner.patch(`/v1/tenant/members/${me.id}`, { status: 'blocked' })).statusCode).toBe(403);
    expect((await admin.patch(`/v1/tenant/members/${me.id}`, { roleKey: 'VIEWER' })).statusCode).toBe(403); // ADMIN не меняет владельца
    expect((await admin.patch(`/v1/tenant/members/${me.id}`, { status: 'blocked' })).statusCode).toBe(403);
    expect((await admin.patch(`/v1/tenant/members/${analyst.id}`, { roleKey: 'OWNER' })).statusCode).toBe(403); // ADMIN не назначает владельца
    expect((await admin.delete(`/v1/tenant/members/${me.id}`)).statusCode).toBe(403);
    // владелец меняет роли других участников; изменения попадают в аудит
    expect((await owner.patch(`/v1/tenant/members/${analyst.id}`, { roleKey: 'EDITOR' })).statusCode).toBe(200);
    expect((await owner.patch(`/v1/tenant/members/${analyst.id}`, { roleKey: 'ANALYST' })).statusCode).toBe(200);
    expect((await owner.patch(`/v1/tenant/members/${analyst.id}`, { roleKey: 'GOD' })).statusCode).toBe(422);
    expect((await owner.patch(`/v1/tenant/members/${analyst.id}`, {})).statusCode).toBe(422);
    const events = (await owner.get('/v1/tenant/audit?action=tenant.member')).json().items;
    expect(events.length).toBeGreaterThanOrEqual(2);
    // заблокированный участник теряет доступ немедленно (активная сессия перестаёт работать в этом тенанте)
    const viewer = await loginAs(ctx, 'i.lapteva@agro22.ru');
    expect((await viewer.get('/v1/articles?limit=1')).statusCode).toBe(200);
    const irina = members.find((m) => m.email === 'i.lapteva@agro22.ru')!;
    expect((await owner.patch(`/v1/tenant/members/${irina.id}`, { status: 'blocked' })).statusCode).toBe(200);
    expect((await viewer.get('/v1/articles?limit=1')).statusCode).toBe(403);
    expect((await owner.patch(`/v1/tenant/members/${irina.id}`, { status: 'active' })).statusCode).toBe(200);
    expect((await viewer.get('/v1/articles?limit=1')).statusCode).toBe(200);
  });

  it('аудит тенанта не содержит событий другого тенанта', async () => {
    const a = (await owner.get('/v1/tenant/audit?limit=200')).json().items as Array<{ action: string }>;
    const b = (await ownerB.get('/v1/tenant/audit?limit=200')).json().items as Array<{ action: string }>;
    expect(a.length).toBeGreaterThan(0);
    expect(b.some((e) => e.action === 'source.created')).toBe(false);
    expect(a.some((e) => e.action === 'tenant.invitation_created')).toBe(true);
  });
});

describe('алерты', () => {
  const rule = (name: string) => ({ name, level: 'mid', keywords: ['дизтопливо', 'цены'], channels: ['Telegram'], scope: ['Все источники'] });

  it('создание, переключение, удаление; личные правила меняет автор, командные — по праву', async () => {
    const created = await owner.post('/v1/alerts', rule('Тест-алерт владельца'));
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    expect((await owner.patch(`/v1/alerts/${id}`, { enabled: false })).statusCode).toBe(200);
    const editor = await loginAs(ctx, 'd.esin@altai.media'); // только alert:manage_own
    expect((await editor.patch(`/v1/alerts/${id}`, { enabled: true })).statusCode).toBe(403);
    expect((await editor.delete(`/v1/alerts/${id}`)).statusCode).toBe(403);
    const analyst = await loginAs(ctx, 'm.kovaleva@altai.media'); // alert:manage_team
    expect((await analyst.patch(`/v1/alerts/${id}`, { enabled: true })).statusCode).toBe(200);
    expect((await owner.delete(`/v1/alerts/${id}`)).statusCode).toBe(200);
    expect((await owner.delete(`/v1/alerts/${id}`)).statusCode).toBe(404);
  });

  it('валидация и лимит тарифа', async () => {
    expect((await owner.post('/v1/alerts', { ...rule('Без слов'), keywords: [] })).statusCode).toBe(422);
    expect((await owner.post('/v1/alerts', { ...rule('Плохой канал'), channels: ['Голубь'] })).statusCode).toBe(422);
    // STARTER: 5 правил (в демо-данных 1) — добираем до лимита и проверяем отказ
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) { const r = await ownerB.post('/v1/alerts', rule(`Лимит ${i}`)); expect(r.statusCode, r.body).toBe(201); ids.push(r.json().id); }
    const over = await ownerB.post('/v1/alerts', rule('Сверх лимита'));
    expect(over.statusCode).toBe(403);
    expect(over.json().details).toMatchObject({ reason: 'plan_limit', entitlement: 'alerts.rules', limit: 5 });
    for (const id of ids) await ownerB.delete(`/v1/alerts/${id}`);
  });

  it('правила другого тенанта не видны и не меняются', async () => {
    const aRules = (await owner.get('/v1/alerts')).json().items as Array<{ id: string; name: string }>;
    const bRules = (await ownerB.get('/v1/alerts')).json().items as Array<{ id: string; name: string }>;
    expect(aRules.some((r) => r.name === 'Упоминания республики')).toBe(false);
    expect(bRules.some((r) => r.name === 'Контроль репутации предприятия')).toBe(false);
    expect((await ownerB.patch(`/v1/alerts/${aRules[0]!.id}`, { enabled: false })).statusCode).toBe(404);
  });
});

describe('отчёты, тарифы, уведомления', () => {
  it('шаблоны и запуск: запрос сохраняется «в очереди»; PPTX и месячный лимит по тарифу', async () => {
    const tpl = (await owner.get('/v1/reports/templates')).json().items;
    expect(tpl).toHaveLength(6);
    const day = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
    const ok = await owner.post('/v1/reports/runs', { templateKey: 'mediametrics', format: 'pdf', from: day(30), to: day(0) });
    expect(ok.statusCode, ok.body).toBe(202);
    expect(ok.json()).toMatchObject({ status: 'queued', implemented: false });
    expect((await owner.post('/v1/reports/runs', { templateKey: 'mediametrics', format: 'pptx', from: day(30), to: day(0) })).json().details).toMatchObject({ reason: 'plan_feature' });
    expect((await owner.post('/v1/reports/runs', { templateKey: 'nope', format: 'pdf', from: day(30), to: day(0) })).statusCode).toBe(404);
    expect((await owner.post('/v1/reports/runs', { templateKey: 'mediametrics', format: 'pdf', from: day(0), to: day(30) })).statusCode).toBe(422);
    const runs = (await owner.get('/v1/reports/runs')).json().items;
    expect(runs.length).toBeGreaterThanOrEqual(6);
    expect((await ownerB.get('/v1/reports/runs')).json().items.every((r: { name: string }) => !r.name.includes('Алтайского края'))).toBe(true);
  });

  it('подписка: счётчики использования и признаки функций; платежи только владельцу; оплата — 501', async () => {
    const sub = (await owner.get('/v1/billing/subscription')).json();
    expect(sub.plan.key).toBe('pro');
    const meter = (k: string) => sub.meters.find((m: { key: string }) => m.key === k);
    expect(meter('sources.active')).toMatchObject({ limit: 50 });
    expect(meter('sources.active').used).toBeGreaterThanOrEqual(18);
    expect(meter('seats')).toMatchObject({ limit: 10 });
    expect(sub.features['feature.api']).toBe(true);
    expect(sub.features['feature.pptx']).toBe(false);
    const plans = (await owner.get('/v1/billing/plans')).json().items;
    expect(plans.map((p: { key: string }) => p.key)).toEqual(['free', 'starter', 'pro', 'enterprise']);
    expect(plans.find((p: { key: string }) => p.key === 'enterprise').priceMinor).toBeNull();
    expect((await admin.get('/v1/billing/payments')).statusCode).toBe(403);
    const pay = (await owner.get('/v1/billing/payments')).json().items;
    expect(pay.length).toBe(4);
    expect(pay.every((p: { provider: string }) => p.provider === 'test')).toBe(true);
    const checkout = await owner.post('/v1/billing/checkout', { planKey: 'pro' });
    expect(checkout.statusCode).toBe(501);
    expect(checkout.json().code).toBe('not_implemented');
  });

  it('уведомления: список с числом непрочитанных, «прочитать все» только для своего тенанта', async () => {
    const before = (await owner.get('/v1/notifications')).json();
    expect(before.items.length).toBeGreaterThanOrEqual(4);
    expect(before.unread).toBeGreaterThan(0);
    expect((await ownerB.get('/v1/notifications')).json().items.some((n: { title: string }) => /Критический сюжет/.test(n.title))).toBe(false);
    expect((await owner.post('/v1/notifications/read-all')).statusCode).toBe(200);
    expect((await owner.get('/v1/notifications')).json().unread).toBe(0);
    expect((await ownerB.get('/v1/notifications')).json().unread).toBeGreaterThan(0); // чужие не затронуты
  });
});
