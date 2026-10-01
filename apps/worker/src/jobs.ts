import type { Queryable } from '@mediaradar/db';
import { createLiveDemoArticle } from '@mediaradar/db';
import { collectSource, type Run } from './collector/collect';
import type { Fetcher } from './collector/http';
import { selectDueSources } from './collector/schedule';
import { verifyArticles } from './collector/verify';

export const QUEUES = { collect: 'collect', demoLive: 'demo-live' } as const;

export interface Publisher {
  publish(channel: string, payload: unknown): Promise<unknown>;
}
export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface CollectContext {
  run: Run;
  bus: Publisher;
  log: Logger;
  /** Очередь для постановки заданий по источникам, которым пора на опрос. */
  enqueueSource: (sourceId: string) => Promise<void>;
  fetch?: Fetcher;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Очередь `collect` обслуживает три вида заданий:
 *  - `tick` (каждую минуту): выбрать источники, которым пора на опрос, и поставить по заданию на каждый;
 *  - `run-source` / `source`: собрать один источник (по расписанию или по кнопке «Парсить»);
 *  - `verify-tick` (каждые 10 минут): проверить, не удалены ли недавние материалы на источнике.
 */
export async function handleCollect(name: string, data: { sourceId?: string }, ctx: CollectContext) {
  const now = (ctx.now ?? (() => new Date()))();
  if (name === 'tick') {
    const ids = await ctx.run((q) => selectDueSources(q, now));
    for (const id of ids) await ctx.enqueueSource(id);
    return { due: ids.length };
  }
  if (name === 'verify-tick')
    return verifyArticles({ run: ctx.run, log: ctx.log, fetch: ctx.fetch, now: ctx.now, sleep: ctx.sleep });
  if (!data.sourceId) return { skipped: 'no_source' as const };
  return collectSource(ctx, data.sourceId);
}

/** Демо-поток: новый синтетический материал → рассылка событий подписанным тенантам (канал tenant:{id}:feed). */
export async function handleDemoLive(
  run: <T>(fn: (q: Queryable) => Promise<T>) => Promise<T>,
  bus: Publisher,
  log: Logger,
) {
  const article = await run((q) => createLiveDemoArticle(q));
  if (!article) {
    log.warn({}, 'demo-live: нет подходящих демо-источников (выполните pnpm db:seed)');
    return null;
  }
  const { tenantIds, ...event } = article;
  await Promise.all(tenantIds.map((t) => bus.publish(`tenant:${t}:feed`, event)));
  log.info({ articleId: article.id, tenants: tenantIds.length }, 'demo-live: материал создан и разослан');
  return { id: article.id, tenants: tenantIds.length };
}
