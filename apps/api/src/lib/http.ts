import { z } from 'zod';

/** snake_case → camelCase для строк из БД (ключи верхнего уровня). */
export function camel<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row))
    out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  return out as T;
}
export const camelAll = <T = Record<string, unknown>>(rows: Array<Record<string, unknown>>): T[] =>
  rows.map((r) => camel<T>(r));

export const uuidParam = z.object({ id: z.string().uuid() });

/** Параметр-список: ?a=1,2 или ?a=1&a=2 → string[] */
export const csv = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) =>
    v === undefined ? [] : (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean),
  );

export const RANGES = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 } as const;
export type RangeKey = keyof typeof RANGES;
export const rangeSchema = z.enum(['24h', '7d', '30d', '90d']).default('7d');

export function rangeBounds(
  range: RangeKey,
  now = new Date(),
): { from: Date; to: Date; prevFrom: Date; prevTo: Date; bucket: 'hour' | 'day'; days: number } {
  const days = RANGES[range];
  const ms = days * 864e5;
  const to = now;
  const from = new Date(to.getTime() - ms);
  return {
    from,
    to,
    prevFrom: new Date(from.getTime() - ms),
    prevTo: from,
    bucket: range === '24h' ? 'hour' : 'day',
    days,
  };
}

export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
