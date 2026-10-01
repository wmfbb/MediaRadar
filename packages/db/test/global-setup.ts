import pg from 'pg';
import { migrate } from '../src/migrate';
import { resetDemo, seedDemo } from '../src/seed';
import { ADMIN_URL, FIXED_NOW } from './env';

/** Перед тестами: актуальная схема + свежие демо-данные в БД mediaradar_test. */
export default async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (e) {
    throw new Error(`Тестовая БД недоступна (${ADMIN_URL}): ${(e as Error).message}\nЗапустите PostgreSQL (make deps-up) и создайте БД mediaradar_test.`);
  }
  try {
    await migrate({ connectionString: ADMIN_URL, apiPassword: 'app_api_dev', workerPassword: 'app_worker_dev' });
    await resetDemo(admin);
    await seedDemo(admin, { now: FIXED_NOW, articles: 600, password: 'Test-Passw0rd!' });
  } finally {
    await admin.end();
  }
}
