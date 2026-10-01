import pino from 'pino';
import { configFromEnv, startWorker } from './worker';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'worker' } });
const running = await startWorker(configFromEnv(logger));
logger.info({}, 'воркер запущен');

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'остановка воркера');
  try {
    await running.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
