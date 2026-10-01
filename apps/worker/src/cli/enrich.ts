import { createDb } from '@mediaradar/db';
import { enrichPending, resetEnrichment, type Run } from '../enrich/enrich';

/**
 * Разметка вручную: `pnpm --filter @mediaradar/worker enrich` — разметить всё неразмеченное;
 * с `--reset` — сначала пометить все материалы неразмеченными (после смены словаря или версии разметчика).
 * Ручные правки темы и тональности при этом сохраняются.
 */
const url = process.env.WORKER_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Задайте WORKER_DATABASE_URL');
  process.exit(1);
}
const db = createDb(url, { max: 2, applicationName: 'mediaradar-enrich-cli' });
const log = {
  info: (o: object, m?: string) => console.log(m ?? '', JSON.stringify(o)),
  warn: (o: object, m?: string) => console.warn(m ?? '', JSON.stringify(o)),
  error: (o: object, m?: string) => console.error(m ?? '', JSON.stringify(o)),
};
try {
  const run: Run = (fn) => db.raw(fn);
  if (process.argv.includes('--reset')) console.log(`Сброшено разметок: ${await resetEnrichment(run)}`);
  let total = 0;
  for (;;) {
    const { processed } = await enrichPending({ run, log });
    if (!processed) break;
    total += processed;
  }
  console.log(`Размечено материалов: ${total}`);
} finally {
  await db.close();
}
