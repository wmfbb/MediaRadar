import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import { AppError, sha256, type PlatformRoleKey, type TenantRoleKey } from '@mediaradar/core';
import {
  PLATFORM_ROLE_PERMISSIONS,
  TENANT_ROLE_PERMISSIONS,
  requiresMfa,
  type MembershipScope,
  type Permission,
} from '@mediaradar/rbac';
import { getSetting } from '@mediaradar/db';
import type { AppDeps } from '../deps';

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  locale: string;
  sessionId: string;
  platformRole: PlatformRoleKey | null;
  totpEnabled: boolean;
  mfaVerified: boolean;
  /** Обязательная 2FA для роли, но пользователь её ещё не включил. */
  mfaSetupRequired: boolean;
  tenantId: string | null;
  tenant: {
    slug: string;
    name: string;
    branding: Record<string, unknown>;
    regionProfile: Record<string, unknown>;
  } | null;
  tenantRole: TenantRoleKey | null;
  roleName: string | null;
  scope: MembershipScope;
  permissions: Set<Permission>;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    authResolved: boolean;
  }
  interface FastifyContextConfig {
    access?: string;
    csrf?: boolean;
  }
  interface FastifyInstance {
    deps: AppDeps;
  }
}

interface SessionRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  mfa_verified: boolean;
  last_seen_at: Date;
  email: string;
  display_name: string;
  locale: string;
  status: string;
  platform_role: PlatformRoleKey | null;
  totp_enabled: boolean;
}
interface MemberRow {
  scope: MembershipScope;
  role_key: TenantRoleKey;
  role_name: string;
  slug: string;
  name: string;
  branding: Record<string, unknown>;
  region_profile: Record<string, unknown>;
}

// Кэш платформенной настройки «обязательная 2FA» (короткий TTL, чтобы не ходить в БД на каждый запрос)
let mfaCache: { at: number; value: boolean } | null = null;
export const resetAuthCaches = () => {
  mfaCache = null;
};

async function mfaEnforced(deps: AppDeps): Promise<boolean> {
  if (mfaCache && Date.now() - mfaCache.at < 15_000) return mfaCache.value;
  const value = await deps.db.system((q) => getSetting<boolean>(q, 'auth.mfa.enforceForAdmins', {}), {
    readOnly: true,
  });
  mfaCache = { at: Date.now(), value };
  return value;
}

export async function loadAuth(deps: AppDeps, token: string): Promise<AuthContext | null> {
  const s = await deps.db.system(async (q) => {
    const r = await q.query<SessionRow>(
      `SELECT s.id, s.user_id, s.tenant_id, s.mfa_verified, s.last_seen_at, u.email, u.display_name, u.locale, u.status, u.platform_role, u.totp_enabled
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [sha256(token)],
    );
    const row = r.rows[0];
    if (row && Date.now() - row.last_seen_at.getTime() > 60_000)
      await q.query(
        'UPDATE sessions SET last_seen_at = now(), expires_at = GREATEST(expires_at, now() + make_interval(days => $2)) WHERE id = $1',
        [row.id, deps.config.SESSION_TTL_DAYS],
      );
    return row;
  });
  if (!s || s.status !== 'active') return null;

  let member: MemberRow | undefined;
  if (s.tenant_id) {
    member = await deps.db.tenant(
      { tenantId: s.tenant_id, userId: s.user_id },
      async (q) =>
        (
          await q.query<MemberRow>(
            `SELECT m.scope, r.key AS role_key, r.name AS role_name, t.slug, t.name, t.branding, t.region_profile
               FROM memberships m JOIN roles r ON r.id = m.role_id JOIN tenants t ON t.id = m.tenant_id
              WHERE m.user_id = $1 AND m.tenant_id = $2 AND m.status = 'active' AND t.status = 'active'`,
            [s.user_id, s.tenant_id],
          )
        ).rows[0],
      { readOnly: true },
    );
  }

  const tenantRole = member?.role_key ?? null;
  const permissions = new Set<Permission>();
  if (tenantRole) for (const p of TENANT_ROLE_PERMISSIONS[tenantRole] ?? []) permissions.add(p);
  if (s.platform_role) for (const p of PLATFORM_ROLE_PERMISSIONS[s.platform_role]) permissions.add(p);

  const mfaSetupRequired =
    !s.totp_enabled &&
    requiresMfa({ tenantRole, platformRole: s.platform_role }) &&
    (await mfaEnforced(deps));

  return {
    userId: s.user_id,
    email: s.email,
    name: s.display_name,
    locale: s.locale,
    sessionId: s.id,
    platformRole: s.platform_role,
    totpEnabled: s.totp_enabled,
    mfaVerified: s.mfa_verified,
    mfaSetupRequired,
    tenantId: member ? s.tenant_id : null,
    tenant: member
      ? {
          slug: member.slug,
          name: member.name,
          branding: member.branding,
          regionProfile: member.region_profile,
        }
      : null,
    tenantRole,
    roleName: member?.role_name ?? null,
    scope: member?.scope ?? {},
    permissions,
  };
}

async function resolve(req: FastifyRequest, app: FastifyInstance): Promise<AuthContext | null> {
  if (req.authResolved) return req.auth;
  req.authResolved = true;
  const token = req.cookies[app.deps.config.SESSION_COOKIE_NAME];
  req.auth = token ? await loadAuth(app.deps, token) : null;
  return req.auth;
}

/** Проверка доступа выполняется на стадии onRequest — до разбора и валидации тела запроса. */
type Guard = { config: { access: string }; onRequest: onRequestAsyncHookHandler };

/**
 * Каждый маршрут обязан объявить уровень доступа через access.*(). Тест проверяет, что ни один маршрут не забыт.
 *  public   — без входа
 *  session  — есть сессия (в т.ч. ожидается 2FA): выход, подтверждение 2FA, /me
 *  account  — сессия с пройденной 2FA; настройка 2FA не обязательна (сама настройка 2FA, смена пароля)
 *  user     — сессия с пройденной 2FA (и настроенной, если она обязательна для роли)
 *  tenant   — user + выбран тенант + право
 *  platform — user + платформенное право
 */
export function createAccess(app: FastifyInstance) {
  const guard = (name: string, check: (a: AuthContext) => void | Promise<void>): Guard => ({
    config: { access: name },
    onRequest: async (req: FastifyRequest, _reply: FastifyReply) => {
      const a = await resolve(req, app);
      if (!a) throw new AppError('unauthorized', 'Требуется вход в систему');
      await check(a);
    },
  });
  const needMfaVerified = (a: AuthContext) => {
    if (!a.mfaVerified)
      throw new AppError('mfa_required', 'Подтвердите вход кодом двухфакторной аутентификации');
  };
  const needUser = (a: AuthContext) => {
    needMfaVerified(a);
    if (a.mfaSetupRequired)
      throw new AppError(
        'mfa_setup_required',
        'Для вашей роли требуется включить двухфакторную аутентификацию',
      );
  };
  const needPermission = (a: AuthContext, perms: Permission[]) => {
    if (!perms.some((p) => a.permissions.has(p))) throw new AppError('forbidden', 'Недостаточно прав');
  };
  return {
    public: (): { config: { access: string } } => ({ config: { access: 'public' } }),
    session: (): Guard => guard('session', () => {}),
    /** Вход выполнен и 2FA подтверждена, но настройка 2FA необязательна — для самой настройки 2FA и смены пароля. */
    account: (): Guard => guard('account', needMfaVerified),
    user: (): Guard => guard('user', needUser),
    tenant: (...perms: Permission[]): Guard =>
      guard(`tenant:${perms.join('|') || '*'}`, (a) => {
        needUser(a);
        if (!a.tenantId) throw new AppError('forbidden', 'Не выбран рабочий тенант', { reason: 'no_tenant' });
        if (perms.length) needPermission(a, perms);
      }),
    platform: (...perms: Permission[]): Guard =>
      guard(`platform:${perms.join('|')}`, (a) => {
        needUser(a);
        needPermission(a, perms);
      }),
  };
}
export type Access = ReturnType<typeof createAccess>;

export const requireAuth = (req: FastifyRequest): AuthContext => {
  if (!req.auth) throw new AppError('unauthorized', 'Требуется вход в систему');
  return req.auth;
};
/** Контекст тенанта текущего запроса (после access.tenant()). */
export const tctx = (req: FastifyRequest) => {
  const a = requireAuth(req);
  if (!a.tenantId) throw new AppError('forbidden', 'Не выбран рабочий тенант', { reason: 'no_tenant' });
  return { tenantId: a.tenantId, userId: a.userId };
};
