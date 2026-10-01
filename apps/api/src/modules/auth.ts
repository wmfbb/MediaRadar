import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AppError, DUMMY_HASH_PROMISE, checkPasswordPolicy, decryptSecret, encryptSecret, generateRecoveryCodes,
  generateTotpSecret, hashPassword, otpauthUrl, randomToken, sha256, verifyPassword, verifyTotp, uuidv7,
} from '@mediaradar/core';
import { requiresMfa } from '@mediaradar/rbac';
import { getSetting, type Queryable } from '@mediaradar/db';
import { audit } from '../lib/audit';
import { slugify } from '../lib/slug';
import { createSession, revokeAllUserSessions, revokeSession } from '../lib/sessions';
import { type Access, type AuthContext, loadAuth, requireAuth, resetAuthCaches } from '../plugins/auth';
import { CSRF_COOKIE, newCsrfToken } from '../plugins/security';

const email = z.string().trim().toLowerCase().email('Некорректный email').max(254);
const password = z.string().min(1, 'Введите пароль').max(200);
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

interface UserRow {
  id: string; email: string; password_hash: string; display_name: string; status: string; platform_role: string | null;
  totp_enabled: boolean; totp_secret_enc: string | null; totp_last_counter: number | null; failed_login_count: number; locked_until: Date | null;
}

export async function authRoutes(app: FastifyInstance, access: Access): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, config, mailer } = app.deps;
  const rl = (max: number, timeWindow: string) => ({ rateLimit: { max, timeWindow } });

  const setCookies = (reply: FastifyReply, token: string) => {
    const base = { path: '/', sameSite: 'lax' as const, secure: config.isProd, maxAge: config.SESSION_TTL_DAYS * 86400 };
    reply.setCookie(config.SESSION_COOKIE_NAME, token, { ...base, httpOnly: true });
    reply.setCookie(CSRF_COOKIE, newCsrfToken(), { ...base, httpOnly: false });
  };
  const clearCookies = (reply: FastifyReply) => {
    reply.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
  };

  /** Содержимое /me: пользователь, текущий тенант, роль, права, список доступных тенантов. */
  async function meBody(a: AuthContext) {
    const tenants = await db.system(async (q) =>
      (await q.query<{ id: string; slug: string; name: string; role_key: string; role_name: string }>(
        `SELECT t.id, t.slug, t.name, r.key AS role_key, r.name AS role_name
           FROM memberships m JOIN tenants t ON t.id = m.tenant_id JOIN roles r ON r.id = m.role_id
          WHERE m.user_id = $1 AND m.status = 'active' AND t.status = 'active' ORDER BY m.created_at, t.slug`, [a.userId])).rows, { readOnly: true });
    const plan = a.tenantId
      ? await db.tenant({ tenantId: a.tenantId, userId: a.userId }, async (q) =>
          (await q.query<{ plan_key: string; name: string; status: string; period_end: Date | null }>(
            'SELECT s.plan_key, p.name, s.status, s.period_end FROM subscriptions s JOIN plans p ON p.key = s.plan_key LIMIT 1')).rows[0], { readOnly: true })
      : undefined;
    const theme = a.tenantId
      ? await db.tenant({ tenantId: a.tenantId, userId: a.userId }, (q) => getSetting<string>(q, 'ui.theme.default', { tenantId: a.tenantId, userId: a.userId }), { readOnly: true })
      : 'system';
    return {
      preferences: { theme },
      user: { id: a.userId, email: a.email, name: a.name, locale: a.locale, platformRole: a.platformRole },
      mfa: { enrolled: a.totpEnabled, verified: a.mfaVerified, setupRequired: a.mfaSetupRequired },
      tenant: a.tenantId && a.tenant ? { id: a.tenantId, slug: a.tenant.slug, name: a.tenant.name, branding: a.tenant.branding, regionProfile: a.tenant.regionProfile } : null,
      plan: plan ? { key: plan.plan_key, name: plan.name, status: plan.status, periodEnd: plan.period_end } : null,
      role: a.tenantRole ? { key: a.tenantRole, name: a.roleName } : null,
      scope: a.scope,
      permissions: [...a.permissions].sort(),
      tenants: tenants.map((t) => ({ id: t.id, slug: t.slug, name: t.name, role: t.role_key, roleName: t.role_name })),
    };
  }

  async function startSession(req: FastifyRequest, reply: FastifyReply, q: Queryable, user: { id: string; totp_enabled: boolean }, tenantId: string | null) {
    const old = req.cookies[config.SESSION_COOKIE_NAME];
    if (old) await q.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(old)]);
    const s = await createSession(q, { userId: user.id, tenantId, mfaVerified: !user.totp_enabled, ip: req.ip, userAgent: req.headers['user-agent'], ttlDays: config.SESSION_TTL_DAYS });
    setCookies(reply, s.token);
    return s;
  }

  // --- регистрация ----------------------------------------------------------------------------
  r.post('/auth/register', {
    config: { access: 'public', ...rl(5, '1 hour') },
    schema: {
      body: z.object({
        email, password: z.string().max(200), name: z.string().trim().min(1).max(120), workspaceName: z.string().trim().min(2).max(120),
      }),
    },
  }, async (req, reply) => {
    const body = req.body;
    const open = await db.system((q) => getSetting<boolean>(q, 'auth.registration.open', {}), { readOnly: true });
    if (!open) throw new AppError('forbidden', 'Самостоятельная регистрация закрыта. Попросите администратора прислать приглашение.');
    const policyError = checkPasswordPolicy(body.password, { email: body.email });
    if (policyError) throw new AppError('validation_failed', policyError, [{ path: 'password', message: policyError }]);
    const hash = await hashPassword(body.password);
    await db.system(async (q) => {
      if ((await q.query('SELECT 1 FROM users WHERE email = $1', [body.email])).rowCount) throw new AppError('conflict', 'Пользователь с таким email уже зарегистрирован');
      const userId = uuidv7();
      const tenantId = uuidv7();
      const base = slugify(body.workspaceName);
      let slug = base;
      for (let i = 0; i < 5 && (await q.query('SELECT 1 FROM tenants WHERE slug = $1', [slug])).rowCount; i++) slug = `${base}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`.slice(0, 48);
      await q.query('INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)', [userId, body.email, hash, body.name]);
      await q.query('INSERT INTO tenants (id, slug, name, region_profile) VALUES ($1, $2, $3, $4)', [tenantId, slug, body.workspaceName, JSON.stringify({ country: 'RU', timezone: 'Europe/Moscow', languages: ['ru'] })]);
      const role = (await q.query<{ id: string }>("SELECT id FROM roles WHERE key = 'OWNER' AND tenant_id IS NULL")).rows[0]!;
      await q.query('INSERT INTO memberships (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [tenantId, userId, role.id]);
      await q.query("INSERT INTO subscriptions (tenant_id, plan_key, status) VALUES ($1, 'free', 'active')", [tenantId]);
      await audit(q, req, { tenantId, actorId: userId, action: 'auth.register', objectType: 'tenant', objectId: tenantId, after: { slug } });
      await startSession(req, reply, q, { id: userId, totp_enabled: false }, tenantId);
    });
    return reply.status(201).send({ status: 'ok' });
  });

  // --- вход -----------------------------------------------------------------------------------
  r.post('/auth/login', {
    config: { access: 'public', ...rl(20, '1 minute') },
    schema: { body: z.object({ email, password }) },
  }, async (req, reply) => {
    const { email: addr, password: pwd } = req.body;
    const user = await db.system(async (q) => (await q.query<UserRow>('SELECT * FROM users WHERE email = $1', [addr])).rows[0]);
    // одинаковое время ответа для существующего и несуществующего пользователя
    const ok = user ? await verifyPassword(user.password_hash, pwd) : (await verifyPassword(await DUMMY_HASH_PROMISE, pwd), false);
    if (user && user.locked_until && user.locked_until > new Date()) {
      const minutes = Math.max(1, Math.ceil((user.locked_until.getTime() - Date.now()) / 60_000));
      throw new AppError('locked', `Слишком много неудачных попыток. Повторите через ${minutes} мин.`);
    }
    if (!user || !ok) {
      if (user) {
        await db.system(async (q) => {
          const fails = user.failed_login_count + 1;
          const lock = fails >= MAX_FAILS;
          await q.query('UPDATE users SET failed_login_count = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id = $1', [user.id, lock ? 0 : fails, lock, LOCK_MINUTES]);
          await audit(q, req, { tenantId: null, actorId: user.id, action: lock ? 'auth.locked' : 'auth.login_failed', objectType: 'user', objectId: user.id });
        });
      }
      throw new AppError('unauthorized', 'Неверный email или пароль');
    }
    if (user.status !== 'active') throw new AppError('forbidden', 'Учётная запись заблокирована. Обратитесь к администратору.');

    await db.system(async (q) => {
      await q.query('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
      // при входе возвращаем пользователя в тенант, где он работал последним; для нового пользователя — в первый по порядку
      const m = await q.query<{ tenant_id: string }>(
        `SELECT m.tenant_id FROM memberships m JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = $1 AND m.status = 'active' AND t.status = 'active'
          ORDER BY (SELECT max(s.created_at) FROM sessions s WHERE s.user_id = m.user_id AND s.tenant_id = m.tenant_id) DESC NULLS LAST, m.created_at, t.slug LIMIT 1`, [user.id]);
      const tenantId = m.rows[0]?.tenant_id ?? null;
      await startSession(req, reply, q, user, tenantId);
      await audit(q, req, { tenantId, actorId: user.id, action: 'auth.login', objectType: 'user', objectId: user.id, after: { mfa: user.totp_enabled } });
    });
    return reply.send({ status: user.totp_enabled ? 'mfa_required' : 'ok' });
  });

  // --- подтверждение второго фактора ------------------------------------------------------------
  r.post('/auth/mfa/verify', {
    onRequest: access.session().onRequest,
    config: { access: 'session', ...rl(10, '1 minute') },
    schema: { body: z.object({ code: z.string().trim().max(32).optional(), recoveryCode: z.string().trim().max(32).optional() }).refine((b) => b.code || b.recoveryCode, 'Введите код') },
  }, async (req, reply) => {
    const a = requireAuth(req);
    if (a.mfaVerified) return reply.send({ status: 'ok' });
    const { code, recoveryCode } = req.body;
    await db.system(async (q) => {
      const u = (await q.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [a.userId])).rows[0]!;
      if (u.locked_until && u.locked_until > new Date()) throw new AppError('locked', 'Слишком много неудачных попыток. Повторите позже.');
      let good = false;
      if (code && u.totp_secret_enc) {
        const counter = verifyTotp(decryptSecret(u.totp_secret_enc, config.encryptionKey), code, { lastCounter: u.totp_last_counter });
        if (counter !== null) {
          good = true;
          await q.query('UPDATE users SET totp_last_counter = $2 WHERE id = $1', [u.id, counter]);
        }
      } else if (recoveryCode) {
        const used = await q.query('UPDATE user_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL', [u.id, sha256(recoveryCode.toLowerCase().replace(/\s/g, ''))]);
        good = (used.rowCount ?? 0) > 0;
        if (good) await audit(q, req, { actorId: u.id, action: 'auth.recovery_code_used', objectType: 'user', objectId: u.id });
      }
      if (!good) {
        const fails = u.failed_login_count + 1;
        const lock = fails >= MAX_FAILS;
        await q.query('UPDATE users SET failed_login_count = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id = $1', [u.id, lock ? 0 : fails, lock, LOCK_MINUTES]);
        throw new AppError('unauthorized', 'Неверный код');
      }
      await q.query('UPDATE users SET failed_login_count = 0 WHERE id = $1', [u.id]);
      await q.query('UPDATE sessions SET mfa_verified = true WHERE id = $1', [a.sessionId]);
    });
    return reply.send({ status: 'ok' });
  });

  r.post('/auth/logout', { ...access.session() }, async (req, reply) => {
    const a = requireAuth(req);
    await db.system(async (q) => {
      await revokeSession(q, a.sessionId);
      await audit(q, req, { actorId: a.userId, tenantId: a.tenantId, action: 'auth.logout' });
    });
    clearCookies(reply);
    return reply.send({ status: 'ok' });
  });

  r.get('/auth/me', { ...access.session() }, async (req) => {
    const a = requireAuth(req);
    if (!a.mfaVerified) return { user: { id: a.userId, email: a.email, name: a.name }, mfa: { enrolled: a.totpEnabled, verified: false, setupRequired: false }, tenant: null, plan: null, role: null, scope: {}, permissions: [], tenants: [] };
    return meBody(a);
  });

  r.post('/auth/switch-tenant', { ...access.user(), schema: { body: z.object({ tenantId: z.string().uuid() }) } }, async (req, reply) => {
    const a = requireAuth(req);
    const ok = await db.system(async (q) => {
      const m = await q.query(`SELECT 1 FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = $1 AND m.tenant_id = $2 AND m.status = 'active' AND t.status = 'active'`, [a.userId, req.body.tenantId]);
      if (!m.rowCount) return false;
      await q.query('UPDATE sessions SET tenant_id = $2 WHERE id = $1', [a.sessionId, req.body.tenantId]);
      await audit(q, req, { tenantId: req.body.tenantId, actorId: a.userId, action: 'auth.switch_tenant', objectType: 'tenant', objectId: req.body.tenantId });
      return true;
    });
    if (!ok) throw new AppError('forbidden', 'У вас нет доступа к этому тенанту');
    return reply.send({ status: 'ok' });
  });

  // --- двухфакторная защита ----------------------------------------------------------------------
  r.post('/auth/2fa/setup', { ...access.account() }, async (req) => {
    const a = requireAuth(req);
    if (a.totpEnabled) throw new AppError('conflict', 'Двухфакторная защита уже включена');
    const secret = generateTotpSecret();
    await db.system((q) => q.query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [a.userId, encryptSecret(secret, config.encryptionKey)]));
    return { secret, otpauthUrl: otpauthUrl({ secret, account: a.email, issuer: 'МедиаРадар' }) };
  });

  r.post('/auth/2fa/enable', { onRequest: access.account().onRequest, config: { access: 'account', ...rl(10, '1 minute') }, schema: { body: z.object({ code: z.string().trim().length(6) }) } }, async (req) => {
    const a = requireAuth(req);
    const codes = generateRecoveryCodes();
    await db.system(async (q) => {
      const u = (await q.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [a.userId])).rows[0]!;
      if (u.totp_enabled) throw new AppError('conflict', 'Двухфакторная защита уже включена');
      if (!u.totp_secret_enc) throw new AppError('bad_request', 'Сначала запросите настройку 2FA');
      const counter = verifyTotp(decryptSecret(u.totp_secret_enc, config.encryptionKey), req.body.code);
      if (counter === null) throw new AppError('unauthorized', 'Неверный код. Проверьте время на телефоне и повторите.');
      await q.query('UPDATE users SET totp_enabled = true, totp_last_counter = $2 WHERE id = $1', [u.id, counter]);
      await q.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [u.id]);
      for (const c of codes) await q.query('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [u.id, sha256(c)]);
      await audit(q, req, { actorId: u.id, action: 'auth.2fa_enabled', objectType: 'user', objectId: u.id });
    });
    resetAuthCaches();
    return { status: 'ok', recoveryCodes: codes };
  });

  r.post('/auth/2fa/disable', { onRequest: access.account().onRequest, config: { access: 'account', ...rl(10, '1 minute') }, schema: { body: z.object({ password, code: z.string().trim().length(6) }) } }, async (req) => {
    const a = requireAuth(req);
    if (requiresMfa({ tenantRole: a.tenantRole, platformRole: a.platformRole }) && (await db.system((q) => getSetting<boolean>(q, 'auth.mfa.enforceForAdmins', {}), { readOnly: true })))
      throw new AppError('forbidden', 'Для вашей роли двухфакторную защиту отключить нельзя');
    await db.system(async (q) => {
      const u = (await q.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [a.userId])).rows[0]!;
      if (!(await verifyPassword(u.password_hash, req.body.password))) throw new AppError('unauthorized', 'Неверный пароль');
      if (!u.totp_enabled || !u.totp_secret_enc || verifyTotp(decryptSecret(u.totp_secret_enc, config.encryptionKey), req.body.code, { lastCounter: u.totp_last_counter }) === null)
        throw new AppError('unauthorized', 'Неверный код');
      await q.query('UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_counter = NULL WHERE id = $1', [u.id]);
      await q.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [u.id]);
      await audit(q, req, { actorId: u.id, action: 'auth.2fa_disabled', objectType: 'user', objectId: u.id });
    });
    return { status: 'ok' };
  });

  // --- пароль -------------------------------------------------------------------------------------
  r.post('/auth/password/change', { ...access.account(), schema: { body: z.object({ current: password, next: z.string().max(200) }) } }, async (req) => {
    const a = requireAuth(req);
    const err = checkPasswordPolicy(req.body.next, { email: a.email });
    if (err) throw new AppError('validation_failed', err, [{ path: 'next', message: err }]);
    const hash = await hashPassword(req.body.next);
    await db.system(async (q) => {
      const u = (await q.query<UserRow>('SELECT password_hash FROM users WHERE id = $1', [a.userId])).rows[0]!;
      if (!(await verifyPassword(u.password_hash, req.body.current))) throw new AppError('unauthorized', 'Неверный текущий пароль');
      await q.query('UPDATE users SET password_hash = $2 WHERE id = $1', [a.userId, hash]);
      await revokeAllUserSessions(q, a.userId, a.sessionId);
      await audit(q, req, { actorId: a.userId, action: 'auth.password_changed', objectType: 'user', objectId: a.userId });
    });
    return { status: 'ok' };
  });

  r.post('/auth/password/forgot', { config: { access: 'public', ...rl(5, '15 minutes') }, schema: { body: z.object({ email }) } }, async (req, reply) => {
    const found = await db.system(async (q) => {
      const u = (await q.query<{ id: string; display_name: string }>("SELECT id, display_name FROM users WHERE email = $1 AND status = 'active'", [req.body.email])).rows[0];
      if (!u) return null;
      const token = randomToken(32);
      await q.query("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [u.id, sha256(token)]);
      await audit(q, req, { tenantId: null, actorId: u.id, action: 'auth.password_reset_requested', objectType: 'user', objectId: u.id });
      return { token, name: u.display_name };
    });
    if (found) await mailer.send({ to: req.body.email, subject: 'Сброс пароля МедиаРадар', text: `Здравствуйте, ${found.name}!\n\nДля смены пароля перейдите по ссылке (действует 1 час):\n${config.APP_BASE_URL}/reset-password?token=${found.token}\n\nЕсли вы не запрашивали сброс — просто проигнорируйте письмо.` });
    // Одинаковый ответ независимо от наличия адреса — не раскрываем, кто зарегистрирован
    return reply.status(202).send({ status: 'accepted' });
  });

  r.post('/auth/password/reset', { config: { access: 'public', ...rl(10, '15 minutes') }, schema: { body: z.object({ token: z.string().min(10).max(200), password: z.string().max(200) }) } }, async (req) => {
    await db.system(async (q) => {
      const t = (await q.query<{ id: string; user_id: string }>('SELECT id, user_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE', [sha256(req.body.token)])).rows[0];
      if (!t) throw new AppError('bad_request', 'Ссылка недействительна или устарела. Запросите сброс заново.');
      const email = (await q.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [t.user_id])).rows[0]!.email;
      const err = checkPasswordPolicy(req.body.password, { email });
      if (err) throw new AppError('validation_failed', err, [{ path: 'password', message: err }]);
      await q.query('UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1', [t.user_id, await hashPassword(req.body.password)]);
      await q.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [t.id]);
      await revokeAllUserSessions(q, t.user_id);
      await audit(q, req, { tenantId: null, actorId: t.user_id, action: 'auth.password_reset', objectType: 'user', objectId: t.user_id });
    });
    return { status: 'ok' };
  });

  // --- приглашения --------------------------------------------------------------------------------
  const invitationByToken = (q: Queryable, token: string) =>
    q.query<{ id: string; tenant_id: string; email: string; role_id: string; role_name: string; tenant_name: string }>(
      `SELECT i.id, i.tenant_id, i.email, i.role_id, r.name AS role_name, t.name AS tenant_name
         FROM invitations i JOIN roles r ON r.id = i.role_id JOIN tenants t ON t.id = i.tenant_id
        WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > now()`, [sha256(token)]);

  r.get('/auth/invitations/:token', { config: { access: 'public', ...rl(30, '1 minute') }, schema: { params: z.object({ token: z.string().min(10).max(200) }) } }, async (req) => {
    const inv = (await db.system((q) => invitationByToken(q, req.params.token), { readOnly: true })).rows[0];
    if (!inv) throw new AppError('not_found', 'Приглашение недействительно или истекло');
    const exists = await db.system(async (q) => (await q.query('SELECT 1 FROM users WHERE email = $1', [inv.email])).rowCount! > 0, { readOnly: true });
    return { email: inv.email, tenantName: inv.tenant_name, roleName: inv.role_name, accountExists: exists };
  });

  r.post('/auth/invitations/accept', {
    config: { access: 'public', ...rl(10, '15 minutes') },
    schema: { body: z.object({ token: z.string().min(10).max(200), name: z.string().trim().min(1).max(120).optional(), password: z.string().max(200).optional() }) },
  }, async (req, reply) => {
    const { token, name, password: pwd } = req.body;
    // Для существующего аккаунта требуется действующая сессия именно этого пользователя (приглашение не даёт войти без пароля).
    const sessionToken = req.cookies[config.SESSION_COOKIE_NAME];
    const cur = sessionToken ? await loadAuth(app.deps, sessionToken) : null;
    await db.system(async (q) => {
      const inv = (await invitationByToken(q, token)).rows[0];
      if (!inv) throw new AppError('not_found', 'Приглашение недействительно или истекло');
      let user = (await q.query<{ id: string; totp_enabled: boolean }>('SELECT id, totp_enabled FROM users WHERE email = $1', [inv.email])).rows[0];
      if (user) {
        if (!cur || cur.userId !== user.id || !cur.mfaVerified) throw new AppError('unauthorized', `Войдите в аккаунт ${inv.email}, затем откройте ссылку-приглашение ещё раз`, { reason: 'login_required', email: inv.email });
      } else {
        if (!name || !pwd) throw new AppError('validation_failed', 'Укажите имя и пароль', [{ path: 'name', message: 'обязательное поле' }]);
        const err = checkPasswordPolicy(pwd, { email: inv.email });
        if (err) throw new AppError('validation_failed', err, [{ path: 'password', message: err }]);
        const id = uuidv7();
        await q.query('INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)', [id, inv.email, await hashPassword(pwd), name]);
        user = { id, totp_enabled: false };
      }
      await q.query('INSERT INTO memberships (tenant_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id, status = \'active\'', [inv.tenant_id, user.id, inv.role_id]);
      await q.query('UPDATE invitations SET accepted_at = now() WHERE id = $1', [inv.id]);
      await audit(q, req, { tenantId: inv.tenant_id, actorId: user.id, action: 'tenant.invitation_accepted', objectType: 'invitation', objectId: inv.id });
      if (cur && cur.userId === user.id) await q.query('UPDATE sessions SET tenant_id = $2 WHERE id = $1', [cur.sessionId, inv.tenant_id]);
      else await startSession(req, reply, q, user, inv.tenant_id);
    });
    return reply.send({ status: 'ok' });
  });

}
