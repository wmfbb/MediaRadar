import pg from 'pg';
import { migrate } from '../src/migrate';
import { resetDemo, seedDemo } from '../src/seed';
import { ADMIN_URL, FIXED_NOW } from './env';

/** Создаёт тестовую БД, если её ещё нет (чистый Postgres после `make deps-up` или в CI). */
async function ensureDatabase() {
  const url = new URL(ADMIN_URL);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';
  const server = new pg.Client({ connectionString: url.toString() });
  try {
    await server.connect();
  } catch (e) {
    throw new Error(`PostgreSQL недоступен: ${(e as Error).message}\nЗапустите зависимости (make deps-up).`);
  }
  try {
    const exists = await server.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!exists.rowCount) await server.query(`CREATE DATABASE ${dbName.replace(/[^a-z0-9_]/gi, '')}`);
  } finally {
    await server.end();
  }
}

/** Перед тестами: актуальная схема + свежие демо-данные в БД mediaradar_test. */
export default async function setup() {
  await ensureDatabase();
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (e) {
    throw new Error(
      `Тестовая БД недоступна (${ADMIN_URL}): ${(e as Error).message}\nЗапустите PostgreSQL (make deps-up) и создайте БД mediaradar_test.`,
    );
  }
  try {
    await migrate({
      connectionString: ADMIN_URL,
      apiPassword: 'app_api_dev',
      workerPassword: 'app_worker_dev',
    });
    await resetDemo(admin);
    await seedDemo(admin, { now: FIXED_NOW, articles: 600, password: 'Test-Passw0rd!' });
  } finally {
    await admin.end();
  }
}
