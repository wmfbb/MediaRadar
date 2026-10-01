import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_ROLE_KEYS, type TenantRoleKey } from '@mediaradar/core';
import { TENANT_ROLE_PERMISSIONS, type Permission } from '@mediaradar/rbac';
import { Client, createTestApp, loginAs, type TestCtx } from './helpers';

const USERS: Record<TenantRoleKey, string> = {
  OWNER: 'a.prokhorov@altai.media', ADMIN: 'n.sergeeva@altai.media', ANALYST: 'm.kovaleva@altai.media',
  EDITOR: 'd.esin@altai.media', MODERATOR: 'o.timoshina@altai.media', VIEWER: 'i.lapteva@agro22.ru',
};

/** Каждая строка: эндпоинт → разрешение, которое он обязан требовать (достаточно любого из перечисленных). */
const ENDPOINTS: Array<{ method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'; url: string; perms: Permission[]; body?: object }> = [
  { method: 'GET', url: '/v1/tenant', perms: ['tenant:read'] },
  { method: 'GET', url: '/v1/articles', perms: ['feed:read'] },
  { method: 'GET', url: '/v1/articles/facets', perms: ['feed:read'] },
  { method: 'GET', url: '/v1/saved-filters', perms: ['filter:manage_own'] },
  { method: 'GET', url: '/v1/dashboard', perms: ['dashboard:read'] },
  { method: 'GET', url: '/v1/analytics/overview', perms: ['dashboard:read'] },
  { method: 'GET', url: '/v1/sources', perms: ['source:read'] },
  { method: 'POST', url: '/v1/sources', perms: ['source:manage_private'], body: {} },
  { method: 'GET', url: '/v1/alerts', perms: ['alert:manage_own'] },
  { method: 'POST', url: '/v1/alerts', perms: ['alert:manage_own', 'alert:manage_team'], body: {} },
  { method: 'GET', url: '/v1/reports/templates', perms: ['report:read'] },
  { method: 'GET', url: '/v1/reports/runs', perms: ['report:read'] },
  { method: 'POST', url: '/v1/reports/runs', perms: ['report:create'], body: {} },
  { method: 'GET', url: '/v1/billing/plans', perms: ['tenant:read'] },
  { method: 'GET', url: '/v1/billing/subscription', perms: ['tenant:read'] },
  { method: 'GET', url: '/v1/billing/payments', perms: ['billing:manage'] },
  { method: 'POST', url: '/v1/billing/checkout', perms: ['billing:manage'], body: { planKey: 'pro' } },
  { method: 'GET', url: '/v1/notifications', perms: ['notification:read'] },
  { method: 'GET', url: '/v1/tenant/members', perms: ['user:read'] },
  { method: 'GET', url: '/v1/tenant/invitations', perms: ['user:read'] },
  { method: 'POST', url: '/v1/tenant/invitations', perms: ['user:manage'], body: {} },
  { method: 'GET', url: '/v1/tenant/roles', perms: ['tenant:read'] },
  { method: 'GET', url: '/v1/tenant/audit', perms: ['audit:read'] },
  { method: 'PATCH', url: '/v1/tenant', perms: ['tenant:settings_basic'], body: {} },
  { method: 'GET', url: '/v1/settings', perms: ['tenant:settings_basic'] },
];

let ctx: TestCtx;
const clients = new Map<TenantRoleKey, Client>();
beforeAll(async () => {
  ctx = await createTestApp();
  for (const role of TENANT_ROLE_KEYS) clients.set(role, await loginAs(ctx, USERS[role]));
});
afterAll(() => ctx.close());

describe('эндпоинты требуют ровно те права, что заявлены в матрице ролей', () => {
  for (const ep of ENDPOINTS) {
    it(`${ep.method} ${ep.url} ← ${ep.perms.join(' | ')}`, async () => {
      for (const role of TENANT_ROLE_KEYS) {
        const allowed = ep.perms.some((p) => (TENANT_ROLE_PERMISSIONS[role] as readonly string[]).includes(p));
        const res = await clients.get(role)!.request(ep.method, ep.url, ep.method === 'GET' ? undefined : (ep.body ?? {}));
        if (allowed) expect(res.statusCode, `${role} должен иметь доступ: ${res.body}`).not.toBe(403);
        else expect(res.statusCode, `${role} не должен иметь доступ`).toBe(403);
        expect(res.statusCode).not.toBe(401);
        expect(res.statusCode === 501 || res.statusCode < 500, `неожиданная ошибка сервера ${res.statusCode}: ${res.body}`).toBe(true);
      }
    });
  }

  it('без входа все эндпоинты отвечают 401', async () => {
    const anon = new Client(ctx.app);
    for (const ep of ENDPOINTS) {
      const res = await anon.request(ep.method, ep.url, ep.method === 'GET' ? undefined : (ep.body ?? {}));
      expect(res.statusCode, `${ep.method} ${ep.url}`).toBe(401);
    }
  });

  it('платформенные эндпоинты недоступны ролям тенанта, включая владельца', async () => {
    for (const role of TENANT_ROLE_KEYS) {
      const c = clients.get(role)!;
      for (const url of ['/v1/admin/tenants', '/v1/admin/audit', '/v1/admin/flags']) expect((await c.get(url)).statusCode, `${role} ${url}`).toBe(403);
      expect((await c.put('/v1/admin/flags/portal.public', { enabled: true })).statusCode).toBe(403);
    }
  });
});
