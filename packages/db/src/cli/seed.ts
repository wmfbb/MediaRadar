import pg from 'pg';
import { DEMO_ACCOUNTS, DEMO_PASSWORD, resetDemo, seedDemo } from '../seed';

const args = new Set(process.argv.slice(2));
if (process.env.NODE_ENV === 'production' && !args.has('--force')) {
  console.error('Демо-данные нельзя загружать в production (добавьте --force, если вы уверены).');
  process.exit(1);
}
const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Задайте MIGRATE_DATABASE_URL');
  process.exit(1);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const existing = await client.query('SELECT count(*)::int AS n FROM tenants');
  if (existing.rows[0].n > 0) {
    if (args.has('--if-empty')) {
      console.log('Демо-данные уже загружены — пропускаю (для пересоздания: make db-reset).');
      process.exit(0);
    }
    if (!args.has('--reset')) {
      console.error('В БД уже есть тенанты. Для пересоздания демо-данных запустите с --reset.');
      process.exit(1);
    }
    await resetDemo(client);
  }
  const s = await seedDemo(client);
  console.log(
    `Готово: тенантов ${Object.keys(s.tenants).length}, источников ${s.sources}, материалов ${s.articles}`,
  );
  console.log(`\nДемо-аккаунты (пароль для всех: ${DEMO_PASSWORD}):`);
  for (const a of DEMO_ACCOUNTS)
    console.log(
      `  ${a.email.padEnd(30)} ${(a.platformRole ?? a.role ?? '').padEnd(12)} ${a.tenant ?? 'платформа'}`,
    );
} finally {
  await client.end();
}
