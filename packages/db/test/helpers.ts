import pg from 'pg';
import { createDb, type Db } from '../src/client';
import { ADMIN_URL, API_URL, WORKER_URL } from './env';

export interface Ids {
  tenantA: string; // altai-krai
  tenantB: string; // demo-republic
  users: Record<string, string>;
}

export async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function loadIds(): Promise<Ids> {
  return withAdmin(async (c) => {
    const t = await c.query<{ slug: string; id: string }>('SELECT slug, id FROM tenants');
    const u = await c.query<{ email: string; id: string }>('SELECT email, id FROM users');
    return {
      tenantA: t.rows.find((r) => r.slug === 'altai-krai')!.id,
      tenantB: t.rows.find((r) => r.slug === 'demo-republic')!.id,
      users: Object.fromEntries(u.rows.map((r) => [r.email, r.id])),
    };
  });
}

export const apiDb = (): Db => createDb(API_URL, { max: 4, applicationName: 'test-api' });
export const workerDb = (): Db => createDb(WORKER_URL, { max: 2, applicationName: 'test-worker' });
