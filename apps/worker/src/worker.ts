import { createServer, type Server } from 'node:http';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from '@mediaradar/core';
import { createDb, type Db } from '@mediaradar/db';
import { QUEUES, handleCollect, handleDemoLive, type Logger } from './jobs';

export interface WorkerOptions {
  redisUrl: string;
  databaseUrl: string;
  demoLive: boolean;
  demoIntervalSec: number;
  /** Периодический сбор источников и проверка удалений (COLLECT_ENABLED). Ручной запуск работает всегда. */
  collect?: boolean;
  healthPort: number | null;
  logger: Logger;
}

export interface RunningWorker {
  db: Db;
  close(): Promise<void>;
}

/** Запускает воркеры очередей BullMQ и (по настройке) планировщик демо-потока. */
export async function startWorker(opts: WorkerOptions): Promise<RunningWorker> {
  const { logger: log } = opts;
  const connection = { url: opts.redisUrl, maxRetriesPerRequest: null as null };
  const db = createDb(opts.databaseUrl, { max: 5, applicationName: 'mediaradar-worker' });
  const pub = new Redis(opts.redisUrl, { maxRetriesPerRequest: 2 });
  pub.on('error', () => {});
  const bus = {
    publish: (channel: string, payload: unknown) => pub.publish(channel, JSON.stringify(payload)),
  };

  const collectQueue = new Queue(QUEUES.collect, { connection });
  collectQueue.on('error', () => {});
  const workers = [
    new Worker(
      QUEUES.collect,
      (job) =>
        handleCollect(job.name, job.data, {
          run: (fn) => db.raw(fn),
          bus,
          log,
          enqueueSource: async (sourceId) => {
            await collectQueue.add(
              'source',
              { sourceId },
              { jobId: `source-${sourceId}`, removeOnComplete: true, removeOnFail: 100 },
            );
          },
        }),
      { connection, concurrency: 3 },
    ),
    new Worker(QUEUES.demoLive, () => handleDemoLive((fn) => db.raw(fn), bus, log), {
      connection,
      concurrency: 1,
    }),
  ];
  for (const w of workers) {
    w.on('failed', (job, err) =>
      log.error({ queue: w.name, jobId: job?.id, err: err.message }, 'задание завершилось ошибкой'),
    );
    w.on('error', (err) => log.error({ queue: w.name, err: err.message }, 'ошибка воркера'));
  }

  if (opts.collect) {
    await collectQueue.upsertJobScheduler(
      'collect-tick',
      { every: 60_000 },
      { name: 'tick', opts: { removeOnComplete: 5, removeOnFail: 20 } },
    );
    await collectQueue.upsertJobScheduler(
      'verify-tick',
      { every: 10 * 60_000 },
      { name: 'verify-tick', opts: { removeOnComplete: 5, removeOnFail: 20 } },
    );
    log.info({}, 'collect: периодический сбор и проверка удалений включены');
  } else {
    await collectQueue.removeJobScheduler('collect-tick').catch(() => {});
    await collectQueue.removeJobScheduler('verify-tick').catch(() => {});
  }

  const demoQueue = new Queue(QUEUES.demoLive, { connection });
  demoQueue.on('error', () => {});
  if (opts.demoLive) {
    await demoQueue.upsertJobScheduler(
      'demo-live-stream',
      { every: opts.demoIntervalSec * 1000 },
      { name: 'tick', opts: { removeOnComplete: 20, removeOnFail: 50 } },
    );
    log.info({ everySec: opts.demoIntervalSec }, 'demo-live: имитатор живого потока включён');
  } else {
    await demoQueue.removeJobScheduler('demo-live-stream').catch(() => {});
  }

  let server: Server | null = null;
  if (opts.healthPort) {
    server = createServer(async (req, res) => {
      if (req.url !== '/healthz') return void res.writeHead(404).end();
      const ok = (await db.ping()) && pub.status === 'ready';
      res
        .writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status: ok ? 'ok' : 'degraded' }));
    }).listen(opts.healthPort, '0.0.0.0');
  }

  return {
    db,
    close: async () => {
      server?.close();
      await Promise.all(workers.map((w) => w.close()));
      await demoQueue.close();
      await collectQueue.close();
      pub.disconnect();
      await db.close();
    },
  };
}

export function configFromEnv(logger: Logger): WorkerOptions {
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: process.env.WORKER_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  if (!config.REDIS_URL) throw new Error('Для воркера обязателен REDIS_URL');
  return {
    redisUrl: config.REDIS_URL,
    databaseUrl: config.DATABASE_URL,
    demoLive: config.DEMO_LIVE,
    demoIntervalSec: Number(process.env.DEMO_LIVE_INTERVAL_SEC ?? 8),
    collect: ['1', 'true', 'yes', 'on'].includes((process.env.COLLECT_ENABLED ?? '').toLowerCase()),
    healthPort: process.env.WORKER_HEALTH_PORT ? Number(process.env.WORKER_HEALTH_PORT) : null,
    logger,
  };
}
