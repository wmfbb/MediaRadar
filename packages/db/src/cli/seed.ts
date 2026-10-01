import pg from 'pg';
import { DEMO_ACCOUNTS, DEMO_PASSWORD, resetDemo, seedDemo } from '../seed';
import { seedRealEntities } from '../seed/real-entities';
import { REAL_SOURCES, seedRealSources } from '../seed/real-sources';

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
  if (args.has('--sources-only')) {
    const r = await seedRealSources(client);
    console.log(`Реестр реальных источников: добавлено ${r.added} из ${r.total}.`);
    const e = await seedRealEntities(client);
    console.log(`Словарь персон и организаций: ${e.total} записей.`);
    process.exit(0);
  }
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
  // --real: аккаунты и тенанты как в демо, но без синтетических материалов и источников-плейсхолдеров; вместо них — реальные источники
  const real = args.has('--real');
  const s = await seedDemo(client, real ? { articles: 0 } : {});
  if (real) {
    await client.query("DELETE FROM sources WHERE meta->>'demo' = 'true'");
    // без материалов вымышленные персоны и организации демо никому не нужны; вместо них — словарь для разметки
    await client.query('DELETE FROM entities');
    await seedRealEntities(client);
    const r = await seedRealSources(client);
    console.log(
      `Реальные источники: ${r.total} (сбор начнётся при запущенном воркере с COLLECT_ENABLED=true).`,
    );
    s.sources = REAL_SOURCES.length;
  }
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
