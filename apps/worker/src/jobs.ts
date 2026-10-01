import type { Queryable } from '@mediaradar/db';
import { createLiveDemoArticle } from '@mediaradar/db';

export const QUEUES = { collect: 'collect', demoLive: 'demo-live' } as const;

export interface Publisher {
  publish(channel: string, payload: unknown): Promise<unknown>;
}
export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * Сбор данных из источника — Фаза 1. Сейчас задание принимается и завершается без обращения к сайтам:
 * очередь, повторные попытки и мониторинг уже работают, обработчик подключится в Фазе 1.
 */
export async function handleCollect(data: { sourceId?: string; tenantId?: string }, log: Logger): Promise<{ implemented: false }> {
  log.info({ ...data }, 'collect: обработчик сбора появится в Фазе 1 (задание принято и завершено без сбора)');
  return { implemented: false };
}

/** Демо-поток: новый синтетический материал → рассылка событий подписанным тенантам (канал tenant:{id}:feed). */
export async function handleDemoLive(run: <T>(fn: (q: Queryable) => Promise<T>) => Promise<T>, bus: Publisher, log: Logger) {
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
