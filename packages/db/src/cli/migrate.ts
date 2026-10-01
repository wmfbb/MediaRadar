import { migrate } from '../migrate';

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Задайте MIGRATE_DATABASE_URL (владелец БД, не прикладная роль)');
  process.exit(1);
}
try {
  const { applied } = await migrate({
    connectionString: url,
    apiPassword: process.env.APP_API_DB_PASSWORD ?? 'app_api_dev',
    workerPassword: process.env.APP_WORKER_DB_PASSWORD ?? 'app_worker_dev',
    log: (m) => console.log(m),
  });
  console.log(applied.length ? `Применено миграций: ${applied.length}` : 'Схема актуальна');
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
