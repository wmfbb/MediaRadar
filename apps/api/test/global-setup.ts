import pg from 'pg';
import { migrate, resetDemo, seedDemo } from '@mediaradar/db';
import { ADMIN_URL, PASSWORD, SERVER_URL, TEST_DB } from './env';

/** Отдельная БД для тестов API (db-пакет использует свою — пакеты тестируются параллельно). */
export default async function setup() {
  const server = new pg.Client({ connectionString: SERVER_URL });
  try {
    await server.connect();
  } catch (e) {
    throw new Error(`PostgreSQL недоступен: ${(e as Error).message}\nЗапустите зависимости (make deps-up).`);
  }
  const exists = await server.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (!exists.rowCount) await server.query(`CREATE DATABASE ${TEST_DB}`);
  await server.end();

  await migrate({
    connectionString: ADMIN_URL,
    apiPassword: 'app_api_dev',
    workerPassword: 'app_worker_dev',
  });
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await resetDemo(admin);
    await seedDemo(admin, { now: new Date(), articles: 700, password: PASSWORD });
  } finally {
    await admin.end();
  }
}
