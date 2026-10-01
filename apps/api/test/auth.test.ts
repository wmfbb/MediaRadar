import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, decryptSecret, loadConfig, parseEncryptionKey, DEV_ENCRYPTION_KEY, totp } from '@mediaradar/core';
import { Client, PASSWORD, createTestApp, loginAs, setPlatformSetting, tenantIds, withAdmin, type TestCtx } from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await setPlatformSetting('auth.mfa.enforceForAdmins', false);
  await setPlatformSetting('auth.registration.open', true);
  await ctx.close();
});

let n = 0;
/** Регистрирует нового пользователя (собственный тенант) — для деструктивных проверок. */
async function registerFresh(): Promise<{ client: Client; email: string }> {
  const email = `fresh${Date.now()}${n++}@example.com`;
  const client = new Client(ctx.app);
  const res = await client.post('/v1/auth/register', { email, password: PASSWORD, name: 'Тест Тестов', workspaceName: 'Тестовое пространство' });
  expect(res.statusCode, res.body).toBe(201);
  return { client, email };
}

describe('вход и сессия', () => {
  it('успешный вход ставит HttpOnly-cookie сессии и читаемый CSRF-cookie', async () => {
    const c = new Client(ctx.app);
    const res = await c.post('/v1/auth/login', { email: 'a.prokhorov@altai.media', password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    const raw = ([] as string[]).concat(res.headers['set-cookie'] as string[]);
    const session = raw.find((x) => x.startsWith('mr_session='))!;
    const csrf = raw.find((x) => x.startsWith('mr_csrf='))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(csrf).not.toMatch(/HttpOnly/i);
  });

  it('/auth/me возвращает пользователя, роль, права, тарифный план и список тенантов', async () => {
    const c = await loginAs(ctx, 'a.prokhorov@altai.media');
    const me = (await c.get('/v1/auth/me')).json();
    expect(me.user.email).toBe('a.prokhorov@altai.media');
    expect(me.tenant.slug).toBe('altai-krai');
    expect(me.role.key).toBe('OWNER');
    expect(me.plan.key).toBe('pro');
    expect(me.permissions).toContain('billing:manage');
    expect(me.tenants).toHaveLength(1);
  });

  it('неверный пароль и несуществующий email дают одинаковый ответ', async () => {
    const c = new Client(ctx.app);
    const wrong = await c.post('/v1/auth/login', { email: 'a.prokhorov@altai.media', password: 'wrong-password-1' });
    const unknown = await c.post('/v1/auth/login', { email: 'nobody@example.com', password: 'wrong-password-1' });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().detail).toBe(unknown.json().detail);
    expect(wrong.headers['content-type']).toMatch(/problem\+json/);
  });

  it('заблокированный пользователь не входит', async () => {
    const res = await new Client(ctx.app).post('/v1/auth/login', { email: 's.bashlykov@client.ru', password: PASSWORD });
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toMatch(/заблокирована/);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('блокировка после 5 неудачных попыток; даже верный пароль не пускает', async () => {
    const { email } = await registerFresh();
    const c = new Client(ctx.app);
    for (let i = 0; i < 5; i++) expect((await c.post('/v1/auth/login', { email, password: 'wrong-password-1' })).statusCode).toBe(401);
    const locked = await c.post('/v1/auth/login', { email, password: PASSWORD });
    expect(locked.statusCode).toBe(423);
    expect(locked.json().code).toBe('locked');
    await withAdmin((a) => a.query('UPDATE users SET locked_until = NULL WHERE email = $1', [email]));
    expect((await c.post('/v1/auth/login', { email, password: PASSWORD })).statusCode).toBe(200);
  });

  it('выход аннулирует сессию', async () => {
    const c = await loginAs(ctx, 'm.kovaleva@altai.media');
    expect((await c.get('/v1/auth/me')).statusCode).toBe(200);
    const old = c.cookies.get('mr_session')!;
    expect((await c.post('/v1/auth/logout')).statusCode).toBe(200);
    const replay = new Client(ctx.app);
    replay.cookies.set('mr_session', old);
    expect((await replay.get('/v1/auth/me')).statusCode).toBe(401);
  });

  it('без cookie защищённые маршруты отвечают 401', async () => {
    const res = await new Client(ctx.app).get('/v1/auth/me');
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('unauthorized');
  });

  it('переключение тенанта: доступно только свои тенанты', async () => {
    const t = await tenantIds();
    const c = await loginAs(ctx, 'm.kovaleva@altai.media');
    expect((await c.get('/v1/auth/me')).json().tenants).toHaveLength(2);
    expect((await c.post('/v1/auth/switch-tenant', { tenantId: t.B })).statusCode).toBe(200);
    const me = (await c.get('/v1/auth/me')).json();
    expect(me.tenant.slug).toBe('demo-republic');
    expect(me.role.key).toBe('VIEWER');
    const owner = await loginAs(ctx, 'a.prokhorov@altai.media');
    expect((await owner.post('/v1/auth/switch-tenant', { tenantId: t.B })).statusCode).toBe(403);
  });

  it('при новом входе пользователь попадает в тенант, где работал последним', async () => {
    const t = await tenantIds();
    const first = await loginAs(ctx, 'm.kovaleva@altai.media', PASSWORD, 'altai-krai');
    await first.post('/v1/auth/switch-tenant', { tenantId: t.B });
    const again = await new Client(ctx.app).login('m.kovaleva@altai.media');
    expect((await again.get('/v1/auth/me')).json().tenant.slug).toBe('demo-republic');
    await again.post('/v1/auth/switch-tenant', { tenantId: t.A });
    const third = await new Client(ctx.app).login('m.kovaleva@altai.media');
    expect((await third.get('/v1/auth/me')).json().tenant.slug).toBe('altai-krai');
  });
});

describe('защита от CSRF и подделки источника', () => {
  it('POST с сессией без CSRF-токена отклоняется, с токеном проходит', async () => {
    const c = await loginAs(ctx, 'a.prokhorov@altai.media');
    const bad = await c.post('/v1/auth/switch-tenant', { tenantId: (await tenantIds()).A }, { csrf: false });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().detail).toMatch(/CSRF/);
    const good = await c.post('/v1/auth/switch-tenant', { tenantId: (await tenantIds()).A });
    expect(good.statusCode).toBe(200);
  });

  it('чужой Origin отклоняется даже без сессии', async () => {
    const res = await new Client(ctx.app).post('/v1/auth/login', { email: 'a.prokhorov@altai.media', password: PASSWORD }, { headers: { origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('двухфакторная аутентификация', () => {
  it('включение, вход с кодом, защита от повторного использования, резервный код', async () => {
    const { client, email } = await registerFresh();
    const setup = (await client.post('/v1/auth/2fa/setup')).json();
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.otpauthUrl).toContain('otpauth://totp/');
    const secret = Buffer.from(base32Decode(setup.secret));
    expect((await client.post('/v1/auth/2fa/enable', { code: '000000' })).statusCode).toBe(401);
    const enable = await client.post('/v1/auth/2fa/enable', { code: totp(secret, Date.now()) });
    expect(enable.statusCode, enable.body).toBe(200);
    const recovery: string[] = enable.json().recoveryCodes;
    expect(recovery).toHaveLength(8);

    // секрет в БД хранится зашифрованным
    const enc = await withAdmin(async (a) => (await a.query<{ totp_secret_enc: string }>('SELECT totp_secret_enc FROM users WHERE email = $1', [email])).rows[0]!.totp_secret_enc);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(decryptSecret(enc, parseEncryptionKey(DEV_ENCRYPTION_KEY))).toBe(setup.secret);
    expect(enc).not.toContain(setup.secret);

    // новый вход: сначала только пароль → mfa_required, защищённые данные недоступны
    const c2 = new Client(ctx.app);
    const login = await c2.post('/v1/auth/login', { email, password: PASSWORD });
    expect(login.json()).toEqual({ status: 'mfa_required' });
    expect((await c2.get('/v1/auth/me')).json().mfa.verified).toBe(false);
    const guarded = await c2.post('/v1/auth/switch-tenant', { tenantId: (await tenantIds()).A });
    expect(guarded.statusCode).toBe(401);
    expect(guarded.json().code).toBe('mfa_required');

    // неверный код, затем верный (следующий шаг времени: текущий уже использован при включении)
    expect((await c2.post('/v1/auth/mfa/verify', { code: '123456' })).statusCode).toBe(401);
    const next = totp(secret, Date.now() + 30_000);
    expect((await c2.post('/v1/auth/mfa/verify', { code: next })).statusCode).toBe(200);
    expect((await c2.get('/v1/auth/me')).json().mfa.verified).toBe(true);

    // повтор того же кода во второй сессии отвергается (replay)
    const c3 = new Client(ctx.app);
    await c3.post('/v1/auth/login', { email, password: PASSWORD });
    expect((await c3.post('/v1/auth/mfa/verify', { code: next })).statusCode).toBe(401);

    // резервный код работает один раз
    expect((await c3.post('/v1/auth/mfa/verify', { recoveryCode: recovery[0] })).statusCode).toBe(200);
    const c4 = new Client(ctx.app);
    await c4.post('/v1/auth/login', { email, password: PASSWORD });
    expect((await c4.post('/v1/auth/mfa/verify', { recoveryCode: recovery[0] })).statusCode).toBe(401);
  });

  it('обязательная 2FA для OWNER/ADMIN: до настройки доступны только /me и настройка 2FA', async () => {
    await setPlatformSetting('auth.mfa.enforceForAdmins', true);
    try {
      const { client } = await registerFresh(); // создатель тенанта — OWNER
      const me = await client.get('/v1/auth/me');
      expect(me.json().mfa.setupRequired).toBe(true);
      const blocked = await client.post('/v1/auth/switch-tenant', { tenantId: (await tenantIds()).A });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().code).toBe('mfa_setup_required');
      expect((await client.post('/v1/auth/2fa/setup')).statusCode).toBe(200);
      // аналитик не обязан иметь 2FA
      const analyst = await loginAs(ctx, 'm.kovaleva@altai.media');
      expect((await analyst.get('/v1/auth/me')).json().mfa.setupRequired).toBe(false);
      // отключить 2FA владельцу нельзя
      const { client: other } = await registerFresh();
      const s = (await other.post('/v1/auth/2fa/setup')).json();
      await other.post('/v1/auth/2fa/enable', { code: totp(Buffer.from(base32Decode(s.secret)), Date.now()) });
      const dis = await other.post('/v1/auth/2fa/disable', { password: PASSWORD, code: totp(Buffer.from(base32Decode(s.secret)), Date.now() + 30_000) });
      expect(dis.statusCode).toBe(403);
    } finally {
      await setPlatformSetting('auth.mfa.enforceForAdmins', false);
    }
  });
});

describe('регистрация', () => {
  it('закрыта настройкой платформы', async () => {
    await setPlatformSetting('auth.registration.open', false);
    try {
      const res = await new Client(ctx.app).post('/v1/auth/register', { email: 'x@example.com', password: PASSWORD, name: 'X', workspaceName: 'Тест' });
      expect(res.statusCode).toBe(403);
    } finally {
      await setPlatformSetting('auth.registration.open', true);
    }
  });

  it('создаёт тенант, владельца и подписку FREE, сразу выполняет вход', async () => {
    const { client } = await registerFresh();
    const me = (await client.get('/v1/auth/me')).json();
    expect(me.role.key).toBe('OWNER');
    expect(me.plan.key).toBe('free');
    expect(me.tenant.slug).toMatch(/^[a-z0-9-]{3,48}$/);
  });

  it('проверяет пароль и уникальность email', async () => {
    const weak = await new Client(ctx.app).post('/v1/auth/register', { email: 'weak@example.com', password: 'short', name: 'W', workspaceName: 'Тест' });
    expect(weak.statusCode).toBe(422);
    const dup = await new Client(ctx.app).post('/v1/auth/register', { email: 'a.prokhorov@altai.media', password: PASSWORD, name: 'D', workspaceName: 'Тест' });
    expect(dup.statusCode).toBe(409);
    const bad = await new Client(ctx.app).post('/v1/auth/register', { email: 'not-an-email', password: PASSWORD, name: 'D', workspaceName: 'Тест' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors[0].path).toBe('email');
  });
});

describe('сброс и смена пароля', () => {
  it('письмо со ссылкой, одноразовый токен, отзыв сессий, вход с новым паролем', async () => {
    const { client, email } = await registerFresh();
    expect((await client.get('/v1/auth/me')).statusCode).toBe(200);
    const forgot = await new Client(ctx.app).post('/v1/auth/password/forgot', { email });
    expect(forgot.statusCode).toBe(202);
    const mail = ctx.mailer.last()!;
    expect(mail.to).toBe(email);
    const token = /token=([\w-]+)/.exec(mail.text)![1]!;
    const fresh = new Client(ctx.app);
    expect((await fresh.post('/v1/auth/password/reset', { token, password: 'short' })).statusCode).toBe(422);
    expect((await fresh.post('/v1/auth/password/reset', { token, password: 'Новый-надёжный-пароль-77' })).statusCode).toBe(200);
    expect((await fresh.post('/v1/auth/password/reset', { token, password: 'Ещё-один-пароль-88' })).statusCode).toBe(400); // токен одноразовый
    expect((await client.get('/v1/auth/me')).statusCode).toBe(401); // старые сессии отозваны
    expect((await new Client(ctx.app).post('/v1/auth/login', { email, password: PASSWORD })).statusCode).toBe(401);
    expect((await new Client(ctx.app).post('/v1/auth/login', { email, password: 'Новый-надёжный-пароль-77' })).statusCode).toBe(200);
  });

  it('для неизвестного адреса ответ тот же, письмо не уходит', async () => {
    const before = ctx.mailer.sent.length;
    const res = await new Client(ctx.app).post('/v1/auth/password/forgot', { email: 'ghost@example.com' });
    expect(res.statusCode).toBe(202);
    expect(ctx.mailer.sent.length).toBe(before);
  });

  it('смена пароля требует текущий и отзывает остальные сессии', async () => {
    const { client, email } = await registerFresh();
    const other = await loginAs(ctx, email);
    expect((await client.post('/v1/auth/password/change', { current: 'wrong-password-1', next: 'Другой-пароль-12345' })).statusCode).toBe(401);
    expect((await client.post('/v1/auth/password/change', { current: PASSWORD, next: 'Другой-пароль-12345' })).statusCode).toBe(200);
    expect((await client.get('/v1/auth/me')).statusCode).toBe(200);
    expect((await other.get('/v1/auth/me')).statusCode).toBe(401);
  });
});

describe('инфраструктура API', () => {
  it('каждый маршрут объявляет уровень доступа; публичные — только из списка', () => {
    const missing = ctx.app.routeTable.filter((r) => !r.access).map((r) => `${r.method} ${r.url}`);
    expect(missing, 'Маршруты без access.*():').toEqual([]);
    const publicRoutes = ctx.app.routeTable.filter((r) => r.access === 'public').map((r) => `${r.method} ${r.url}`).sort();
    expect(publicRoutes).toEqual([
      'GET /healthz', 'GET /metrics', 'GET /readyz', 'GET /v1/auth/invitations/:token', 'POST /v1/auth/invitations/accept',
      'POST /v1/auth/login', 'POST /v1/auth/password/forgot', 'POST /v1/auth/password/reset', 'POST /v1/auth/register',
    ].sort());
  });

  it('заголовки безопасности, request-id, формат ошибок', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ status: 404, code: 'not_found' });
  });

  it('healthz/readyz; метрики закрыты от внешних адресов', async () => {
    expect((await ctx.app.inject({ url: '/healthz' })).json()).toEqual({ status: 'ok' });
    const ready = await ctx.app.inject({ url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks.database).toBe(true);
    const external = await ctx.app.inject({ url: '/metrics', remoteAddress: '203.0.113.7' });
    expect(external.statusCode).toBe(403);
    const local = await ctx.app.inject({ url: '/metrics', remoteAddress: '127.0.0.1' });
    expect(local.statusCode).toBe(200);
    expect(local.body).toContain('mediaradar_http_request_duration_seconds');
  });

  it('ограничение частоты: 429 после превышения лимита входа', async () => {
    const limited = await createTestApp({ rateLimit: true });
    try {
      const c = new Client(limited.app);
      let last = 0;
      for (let i = 0; i < 22; i++) last = (await c.post('/v1/auth/login', { email: 'ghost@example.com', password: 'wrong-password-1' })).statusCode;
      expect(last).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it('production-конфиг отвергает слабые настройки', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'x' })).toThrow();
  });
});
