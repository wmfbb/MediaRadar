import { Redis } from 'ioredis';
import { loadConfig } from '@mediaradar/core';
import { createDb } from '@mediaradar/db';
import { buildApp } from './app';
import { MemoryBus, RedisBus } from './lib/bus';
import { LogMailer } from './lib/mailer';
import { BullQueueStats, NoQueueStats } from './lib/queue-stats';

const config = loadConfig();
const db = createDb(config.DATABASE_URL, { max: 20, applicationName: 'mediaradar-api' });
const bus = config.REDIS_URL ? new RedisBus(config.REDIS_URL) : new MemoryBus();
const queues = config.REDIS_URL ? new BullQueueStats(config.REDIS_URL) : new NoQueueStats();
const checks: Record<string, () => Promise<boolean>> = {};
if (config.REDIS_URL) {
  const probe = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  probe.on('error', () => {});
  checks.redis = async () => {
    if (probe.status === 'wait') await probe.connect();
    return (await probe.ping()) === 'PONG';
  };
}

const mailer = new LogMailer();
const app = await buildApp({ config, db, bus, queues, jobs: queues, checks, mailer });
mailer.attach(app.log);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'остановка');
  try {
    await app.close();
    await Promise.all([bus.close(), queues.close(), db.close()]);
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
