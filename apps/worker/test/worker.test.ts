import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUES, handleCollect, handleDemoLive } from '../src/jobs';
import { startWorker, type RunningWorker } from '../src/worker';
import { TEST_DB } from './global-setup';

const base = process.env.TEST_PG_URL ?? 'postgres://mediaradar:mediaradar_dev@localhost:5432';
const WORKER_URL = `postgres://app_worker:app_worker_dev@localhost:5432/${TEST_DB}`;
const ADMIN_URL = `${base}/${TEST_DB}`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
const log = { info: () => {}, warn: () => {}, error: () => {} };

let running: RunningWorker;
beforeAll(async () => {
  running = await startWorker({ redisUrl: REDIS_URL, databaseUrl: WORKER_URL, demoLive: false, demoIntervalSec: 1, healthPort: null, logger: log });
});
afterAll(async () => {
  const q = new Queue(QUEUES.collect, { connection: { url: REDIS_URL } });
  await q.obliterate({ force: true }).catch(() => {});
  await q.close();
  await running.close();
});

const articleCount = async () => {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    return (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM articles')).rows[0]!.n;
  } finally {
    await c.end();
  }
};

describe('воркер', () => {
  it('collect: честная заглушка — задание принимается, данные не собираются', async () => {
    expect(await handleCollect({ sourceId: 's' }, log)).toEqual({ implemented: false });
  });

  it('задание из очереди collect выполняется реальным воркером BullMQ через Redis', async () => {
    const q = new Queue(QUEUES.collect, { connection: { url: REDIS_URL } });
    const job = await q.add('run-source', { sourceId: 'x' });
    const deadline = Date.now() + 8000;
    let state = await job.getState();
    while (state !== 'completed' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      state = await job.getState();
    }
    expect(state).toBe('completed');
    expect((await job.getState()) === 'completed' && (await q.getJob(job.id!))?.returnvalue).toEqual({ implemented: false });
    await q.close();
  });

  it('demo-live: материал создаётся и событие приходит подписчикам тенанта через Redis pub/sub', async () => {
    const sub = new Redis(REDIS_URL);
    const tenant = await (async () => {
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      try {
        return (await c.query<{ id: string }>("SELECT id FROM tenants WHERE slug = 'altai-krai'")).rows[0]!.id;
      } finally {
        await c.end();
      }
    })();
    const received: any[] = [];
    await sub.subscribe(`tenant:${tenant}:feed`);
    sub.on('message', (_c, m) => received.push(JSON.parse(m)));
    const before = await articleCount();
    const pub = new Redis(REDIS_URL);
    let published = 0;
    // несколько попыток: источник выбирается случайно и может оказаться не из подписок тенанта «Алтайский край»
    for (let i = 0; i < 12 && received.length === 0; i++) {
      await handleDemoLive((fn) => running.db.raw(fn), { publish: async (ch, p) => { published++; return pub.publish(ch, JSON.stringify(p)); } }, log);
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(published).toBeGreaterThan(0);
    expect(await articleCount()).toBeGreaterThan(before);
    expect(received[0]).toMatchObject({ title: expect.any(String), source: { domain: expect.any(String) }, sentiment: { label: expect.stringMatching(/^(VP|P|N|NG|VN)$/) } });
    expect(received[0]).not.toHaveProperty('tenantIds'); // служебные данные маршрутизации клиенту не уходят
    sub.disconnect();
    pub.disconnect();
  });

  it('планировщик demo-live создаёт повторяющееся задание и снимает его при выключении', async () => {
    const on = await startWorker({ redisUrl: REDIS_URL, databaseUrl: WORKER_URL, demoLive: true, demoIntervalSec: 1, healthPort: null, logger: log });
    const q = new Queue(QUEUES.demoLive, { connection: { url: REDIS_URL } });
    expect((await q.getJobSchedulers()).map((s) => s.key)).toContain('demo-live-stream');
    await new Promise((r) => setTimeout(r, 2500));
    const completed = await q.getJobCounts('completed');
    expect(completed.completed).toBeGreaterThan(0);
    await on.close();
    const off = await startWorker({ redisUrl: REDIS_URL, databaseUrl: WORKER_URL, demoLive: false, demoIntervalSec: 1, healthPort: null, logger: log });
    expect((await q.getJobSchedulers()).map((s) => s.key)).not.toContain('demo-live-stream');
    await off.close();
    await q.obliterate({ force: true });
    await q.close();
  });
});
