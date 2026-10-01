import { Queue } from 'bullmq';
import type { JobQueue, QueueStats } from '../deps';

export const QUEUE_NAMES = ['collect', 'demo-live'] as const;

export class BullQueueStats implements QueueStats, JobQueue {
  private queues: Queue[];
  constructor(redisUrl: string) {
    this.queues = QUEUE_NAMES.map((name) => new Queue(name, { connection: { url: redisUrl, maxRetriesPerRequest: null } }));
    for (const q of this.queues) q.on('error', () => {});
  }
  async counts() {
    try {
      const all = await Promise.all(this.queues.map((q) => q.getJobCounts('waiting', 'active', 'delayed', 'failed')));
      const sum = (k: string) => all.reduce((s, c) => s + (c[k] ?? 0), 0);
      return { waiting: sum('waiting'), active: sum('active'), delayed: sum('delayed'), failed: sum('failed'), available: true };
    } catch {
      return { waiting: 0, active: 0, delayed: 0, failed: 0, available: false };
    }
  }
  async enqueue(queue: 'collect', name: string, data: Record<string, unknown>): Promise<boolean> {
    const q = this.queues.find((x) => x.name === queue);
    if (!q) return false;
    try {
      await q.add(name, data, { removeOnComplete: 500, removeOnFail: 500, attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
      return true;
    } catch {
      return false;
    }
  }
  async close() {
    await Promise.all(this.queues.map((q) => q.close()));
  }
}

export class NoQueueStats implements QueueStats, JobQueue {
  async enqueue(): Promise<boolean> {
    return false;
  }
  async counts() {
    return { waiting: 0, active: 0, delayed: 0, failed: 0, available: false };
  }
  async close() {}
}
