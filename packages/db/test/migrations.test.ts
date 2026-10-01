import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultMigrationsDir, migrate } from '../src/migrate';
import { ADMIN_URL } from './env';

const opts = { connectionString: ADMIN_URL, apiPassword: 'app_api_dev', workerPassword: 'app_worker_dev' };

describe('миграции', () => {
  it('повторный запуск ничего не применяет (идемпотентность)', async () => {
    const r = await migrate(opts);
    expect(r.applied).toEqual([]);
  });

  it('изменённая после применения миграция отвергается', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mr-migrations-'));
    await cp(defaultMigrationsDir(), dir, { recursive: true });
    const f = join(dir, '0001_foundation.sql');
    await writeFile(f, (await readFile(f, 'utf8')) + '\n-- tampered\n');
    await expect(migrate({ ...opts, migrationsDir: dir })).rejects.toThrow(/изменена после применения/);
  });

  it('справочные данные синхронизированы с кодом: 6 системных ролей, 4 тарифа, пресет тем', async () => {
    const { withAdmin } = await import('./helpers');
    const r = await withAdmin(async (c) => ({
      roles: (await c.query("SELECT count(*)::int n FROM roles WHERE tenant_id IS NULL")).rows[0].n,
      plans: (await c.query('SELECT count(*)::int n FROM plans')).rows[0].n,
      topics: (await c.query('SELECT count(*)::int n FROM topics WHERE tenant_id IS NULL')).rows[0].n,
      ownerPerms: (await c.query("SELECT count(*)::int n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = 'OWNER' AND r.tenant_id IS NULL")).rows[0].n,
    }));
    expect(r.roles).toBe(6);
    expect(r.plans).toBe(4);
    expect(r.topics).toBe(7);
    const { TENANT_PERMISSIONS } = await import('@mediaradar/rbac');
    expect(r.ownerPerms).toBe(TENANT_PERMISSIONS.length);
  });
});
