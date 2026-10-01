/** Адреса тестовой БД. Переопределяются переменными окружения (CI). */
export const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://mediaradar:mediaradar_dev@localhost:5432/mediaradar_test';
export const API_URL = process.env.TEST_API_DATABASE_URL ?? 'postgres://app_api:app_api_dev@localhost:5432/mediaradar_test';
export const WORKER_URL = process.env.TEST_WORKER_DATABASE_URL ?? 'postgres://app_worker:app_worker_dev@localhost:5432/mediaradar_test';
export const FIXED_NOW = new Date('2026-10-01T05:00:00.000Z');
