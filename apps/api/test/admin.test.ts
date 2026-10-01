import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from './helpers';
import { createTestApp, loginAs, setPlatformSetting, tenantIds, withAdmin, type TestCtx } from './helpers';

let ctx: TestCtx;
let superAdmin: Client;
let support: Client;
let ownerB: Client;
let tenants: { A: string; B: string };

beforeAll(async () => {
  ctx = await createTestApp();
  tenants = await tenantIds();
  await withAdmin(async (c) => {
    const hash = (
      await c.query<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE email = 'admin@mediaradar.local'",
      )
    ).rows[0]!.password_hash;
    await c.query(
      "INSERT INTO users (email, password_hash, display_name, platform_role) VALUES ('support@mediaradar.local', $1, 'Поддержка', 'SUPPORT') ON CONFLICT DO NOTHING",
      [hash],
    );
  });
  [superAdmin, support, ownerB] = await Promise.all([
    loginAs(ctx, 'admin@mediaradar.local'),
    loginAs(ctx, 'support@mediaradar.local'),
    loginAs(ctx, 'owner@altai-republic.demo'),
  ]);
});
afterAll(async () => {
  await withAdmin((c) => c.query("UPDATE tenants SET status = 'active' WHERE id = $1", [tenants.B]));
  await ctx.close();
});

describe('платформенная админка', () => {
  it('SUPER_ADMIN без тенанта: платформенные права есть, рабочие данные тенанта недоступны', async () => {
    const me = (await superAdmin.get('/v1/auth/me')).json();
    expect(me.tenant).toBeNull();
    expect(me.permissions).toEqual(
      expect.arrayContaining(['platform:tenants', 'platform:settings', 'platform:flags', 'platform:audit']),
    );
    expect(me.permissions.some((p: string) => p === 'feed:read')).toBe(false);
    const res = await superAdmin.get('/v1/articles');
    expect(res.statusCode).toBe(403);
    expect(res.json().details).toMatchObject({ reason: 'no_tenant' });
  });

  it('список тенантов с составом и тарифом', async () => {
    const t = (await superAdmin.get('/v1/admin/tenants')).json().items as Array<{
      slug: string;
      members: number;
      planKey: string;
      sources: number;
    }>;
    const altai = t.find((x) => x.slug === 'altai-krai')!;
    expect(altai).toMatchObject({ planKey: 'pro' });
    expect(altai.members).toBeGreaterThanOrEqual(6); // активные участники (заблокированный не считается)
    expect(altai.sources).toBeGreaterThanOrEqual(18);
    expect(t.find((x) => x.slug === 'demo-republic')!.planKey).toBe('starter');
  });

  it('приостановка тенанта мгновенно закрывает доступ его пользователям, возобновление возвращает', async () => {
    expect((await ownerB.get('/v1/articles?limit=1')).statusCode).toBe(200);
    expect(
      (await superAdmin.patch(`/v1/admin/tenants/${tenants.B}`, { status: 'suspended' })).statusCode,
    ).toBe(200);
    const blocked = await ownerB.get('/v1/articles?limit=1');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().details).toMatchObject({ reason: 'no_tenant' });
    expect((await superAdmin.patch(`/v1/admin/tenants/${tenants.B}`, { status: 'active' })).statusCode).toBe(
      200,
    );
    expect((await ownerB.get('/v1/articles?limit=1')).statusCode).toBe(200);
    expect((await superAdmin.patch(`/v1/admin/tenants/${tenants.B}`, { status: 'weird' })).statusCode).toBe(
      422,
    );
    expect(
      (await superAdmin.patch('/v1/admin/tenants/00000000-0000-4000-8000-000000000000', { status: 'active' }))
        .statusCode,
    ).toBe(404);
  });

  it('платформенный журнал аудита охватывает все тенанты; событие виден и самому тенанту', async () => {
    const all = (await superAdmin.get('/v1/admin/audit?action=platform.&limit=50')).json().items as Array<{
      action: string;
      tenantId: string;
      tenantName: string;
    }>;
    expect(
      all.some(
        (e) =>
          e.action === 'platform.tenant_status_changed' &&
          e.tenantId === tenants.B &&
          e.tenantName === 'Республика Алтай',
      ),
    ).toBe(true);
    const own = (await ownerB.get('/v1/tenant/audit?action=platform.')).json().items as Array<{
      action: string;
    }>;
    expect(own.some((e) => e.action === 'platform.tenant_status_changed')).toBe(true);
    const filtered = (await superAdmin.get(`/v1/admin/audit?tenantId=${tenants.B}&limit=50`)).json()
      .items as Array<{ tenantId: string }>;
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((e) => e.tenantId === tenants.B)).toBe(true);
  });

  it('флаги функций: чтение и переключение через защищённую функцию БД; запись напрямую запрещена', async () => {
    const flags = (await superAdmin.get('/v1/admin/flags')).json().items as Array<{
      key: string;
      enabled: boolean;
    }>;
    expect(flags.map((f) => f.key)).toEqual(
      expect.arrayContaining(['portal.public', 'ai.gateway', 'billing.live']),
    );
    expect((await superAdmin.put('/v1/admin/flags/ai.gateway', { enabled: true })).statusCode).toBe(200);
    expect(
      (await superAdmin.get('/v1/admin/flags'))
        .json()
        .items.find((f: { key: string }) => f.key === 'ai.gateway').enabled,
    ).toBe(true);
    expect((await superAdmin.put('/v1/admin/flags/ai.gateway', { enabled: false })).statusCode).toBe(200);
    expect((await superAdmin.put('/v1/admin/flags/no.such', { enabled: true })).statusCode).toBe(404);
    // функция не работает вне платформенного контекста
    await expect(
      ctx.db.tenant({ tenantId: tenants.A }, (q) => q.query("SELECT set_feature_flag('ai.gateway', true)")),
    ).rejects.toThrow(/insufficient_privilege/);
  });

  it('SUPPORT: смотрит тенанты и аудит, но не меняет ничего', async () => {
    expect((await support.get('/v1/admin/tenants')).statusCode).toBe(200);
    expect((await support.get('/v1/admin/audit')).statusCode).toBe(200);
    expect((await support.patch(`/v1/admin/tenants/${tenants.A}`, { status: 'suspended' })).statusCode).toBe(
      403,
    );
    expect((await support.get('/v1/admin/flags')).statusCode).toBe(403);
    expect((await support.put('/v1/admin/flags/ai.gateway', { enabled: true })).statusCode).toBe(403);
    expect((await support.get('/v1/settings')).statusCode).toBe(403);
  });

  it('при обязательной 2FA платформенные роли не работают без неё', async () => {
    await setPlatformSetting('auth.mfa.enforceForAdmins', true);
    try {
      const res = await superAdmin.get('/v1/admin/tenants');
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('mfa_setup_required');
      expect((await superAdmin.get('/v1/auth/me')).statusCode).toBe(200);
    } finally {
      await setPlatformSetting('auth.mfa.enforceForAdmins', false);
    }
    expect((await superAdmin.get('/v1/admin/tenants')).statusCode).toBe(200);
  });
});
