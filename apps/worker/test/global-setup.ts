import pg from 'pg';
import { migrate, resetDemo, seedDemo } from '@mediaradar/db';

export const TEST_DB = 'mediaradar_test_worker';
const base = process.env.TEST_PG_URL ?? 'postgres://mediaradar:mediaradar_dev@localhost:5432';

export default async function setup() {
  const server = new pg.Client({ connectionString: `${base}/postgres` });
  await server.connect();
  if (!(await server.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB])).rowCount) await server.query(`CREATE DATABASE ${TEST_DB}`);
  await server.end();
  const url = `${base}/${TEST_DB}`;
  await migrate({ connectionString: url, apiPassword: 'app_api_dev', workerPassword: 'app_worker_dev' });
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await resetDemo(admin);
    await seedDemo(admin, { articles: 200, password: 'Test-Passw0rd!' });
  } finally {
    await admin.end();
  }
}
