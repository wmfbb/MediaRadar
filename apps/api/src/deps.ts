import type { Config } from '@mediaradar/core';
import type { Db } from '@mediaradar/db';

export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

export interface EventBus {
  publish(channel: string, payload: unknown): Promise<void>;
  subscribe(channel: string, handler: (payload: unknown) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export interface QueueStats {
  /** Сводка по очередям BullMQ: ожидают / в работе / отложены / с ошибкой. */
  counts(): Promise<{ waiting: number; active: number; delayed: number; failed: number; available: boolean }>;
  close(): Promise<void>;
}

export interface JobQueue {
  /** Ставит задание в очередь BullMQ. false — очередь недоступна (нет Redis). */
  enqueue(queue: 'collect', name: string, data: Record<string, unknown>): Promise<boolean>;
}

export interface AppDeps {
  config: Config;
  db: Db;
  bus: EventBus;
  mailer: Mailer;
  queues: QueueStats;
  jobs: JobQueue;
  /** Готовность внешних зависимостей для /readyz. */
  checks?: Record<string, () => Promise<boolean>>;
}
