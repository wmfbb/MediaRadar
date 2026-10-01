import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLiveDemoArticle } from '../src/seed/live';
import type { Db } from '../src/client';
import { apiDb, loadIds, withAdmin, workerDb, type Ids } from './helpers';

let worker: Db;
let api: Db;
let ids: Ids;
beforeAll(async () => {
  worker = workerDb();
  api = apiDb();
  ids = await loadIds();
});
afterAll(async () => {
  await worker.close();
  await api.close();
});

describe('имитатор живого потока (роль воркера)', () => {
  it('создаёт материал в общем источнике; он виден подписанным тенантам и скрыт от остальных', async () => {
    const before = await withAdmin(
      async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM articles')).rows[0]!.n,
    );
    const live = await worker.raw((q) => createLiveDemoArticle(q));
    expect(live).not.toBeNull();
    expect(live!.tenantIds.length).toBeGreaterThan(0);
    expect(live!.title.length).toBeGreaterThan(10);
    expect(live!.sentiment.label).toMatch(/^(VP|P|N|NG|VN)$/);
    const after = await withAdmin(
      async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM articles')).rows[0]!.n,
    );
    expect(after).toBe(before + 1);

    for (const tenantId of [ids.tenantA, ids.tenantB]) {
      const seen = await api.tenant(
        { tenantId },
        async (q) => (await q.query('SELECT 1 FROM articles WHERE id = $1', [live!.id])).rowCount,
        { readOnly: true },
      );
      expect(seen === 1, `тенант ${tenantId}`).toBe(live!.tenantIds.includes(tenantId));
    }
  });

  it('функция подписчиков доступна только воркеру', async () => {
    const src = await withAdmin(
      async (c) =>
        (await c.query<{ id: string }>("SELECT id FROM sources WHERE domain = 'tass.ru'")).rows[0]!.id,
    );
    const subs = await worker.raw(
      async (q) => (await q.query('SELECT worker_source_subscribers($1)', [src])).rowCount,
    );
    expect(subs).toBe(2); // tass.ru — общий источник обоих тенантов
    await expect(
      api.tenant({ tenantId: ids.tenantA }, (q) => q.query('SELECT worker_source_subscribers($1)', [src])),
    ).rejects.toThrow(/permission denied/i);
  });

  it('API-роль не может создавать материалы общего слоя', async () => {
    await expect(api.tenant({ tenantId: ids.tenantA }, (q) => createLiveDemoArticle(q))).rejects.toThrow();
  });
});
