const base = process.env.TEST_PG_URL ?? 'postgres://mediaradar:mediaradar_dev@localhost:5432';
export const TEST_DB = 'mediaradar_test_api';
export const ADMIN_URL = `${base}/${TEST_DB}`;
export const SERVER_URL = `${base}/postgres`;
export const API_URL = process.env.TEST_API_DATABASE_URL ?? `postgres://app_api:app_api_dev@localhost:5432/${TEST_DB}`;
export const WORKER_URL = process.env.TEST_WORKER_DATABASE_URL ?? `postgres://app_worker:app_worker_dev@localhost:5432/${TEST_DB}`;
export const PASSWORD = 'Test-Passw0rd!';
