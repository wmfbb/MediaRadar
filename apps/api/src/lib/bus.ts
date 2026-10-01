import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import type { EventBus } from '../deps';

export class MemoryBus implements EventBus {
  private ee = new EventEmitter().setMaxListeners(0);
  async publish(channel: string, payload: unknown): Promise<void> {
    this.ee.emit(channel, payload);
  }
  async subscribe(channel: string, handler: (payload: unknown) => void): Promise<() => Promise<void>> {
    this.ee.on(channel, handler);
    return async () => void this.ee.off(channel, handler);
  }
  async close(): Promise<void> {
    this.ee.removeAllListeners();
  }
}

/** Шина событий поверх Redis pub/sub: воркеры публикуют, WebSocket-шлюзы API рассылают клиентам. */
export class RedisBus implements EventBus {
  private pub: Redis;
  private sub: Redis;
  private handlers = new Map<string, Set<(payload: unknown) => void>>();

  constructor(url: string) {
    this.pub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
    this.sub = new Redis(url, { lazyConnect: false });
    this.pub.on('error', () => {});
    this.sub.on('error', () => {});
    this.sub.on('message', (channel, message) => {
      let payload: unknown = message;
      try {
        payload = JSON.parse(message);
      } catch {
        /* оставляем строкой */
      }
      for (const h of this.handlers.get(channel) ?? []) h(payload);
    });
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    await this.pub.publish(channel, JSON.stringify(payload));
  }

  async subscribe(channel: string, handler: (payload: unknown) => void): Promise<() => Promise<void>> {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.sub.subscribe(channel);
    }
    set.add(handler);
    return async () => {
      const s = this.handlers.get(channel);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) {
        this.handlers.delete(channel);
        await this.sub.unsubscribe(channel);
      }
    };
  }

  async close(): Promise<void> {
    this.pub.disconnect();
    this.sub.disconnect();
  }
}
