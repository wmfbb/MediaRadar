import type { Queryable } from '@mediaradar/db';

const MAX_BACKOFF_MIN = 6 * 60;

/** Периодичность опроса в минутах из cron-строки реестра. Поддерживаются простые формы; остальное — раз в 30 минут. */
export function cronToMinutes(cron: string): number {
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return 30;
  const [min, hour, dom, mon, dow] = p;
  if (dom !== '*' || mon !== '*' || dow !== '*') return 30;
  if (min === '*' && hour === '*') return 1;
  const everyMin = /^\*\/(\d+)$/.exec(min!);
  if (everyMin && hour === '*') return Math.max(1, Number(everyMin[1]));
  if (min === '0' && hour === '*') return 60;
  const everyHour = /^\*\/(\d+)$/.exec(hour!);
  if (/^\d+$/.test(min!) && everyHour) return Math.max(1, Number(everyHour[1])) * 60;
  if (/^\d+$/.test(min!) && /^\d+$/.test(hour!)) return 24 * 60;
  return 30;
}

/** Когда источник снова «созрел»: интервал, умноженный на 2^ошибок (но не больше 16×), не дольше 6 часов. */
export function nextRunAt(lastRunAt: Date, cron: string, errorCount: number): Date {
  const base = cronToMinutes(cron);
  const wait = Math.min(base * Math.min(2 ** errorCount, 16), Math.max(base, MAX_BACKOFF_MIN));
  return new Date(lastRunAt.getTime() + wait * 60_000);
}

/** Источники, которые пора опросить: активные или с ошибками, с настроенным сбором, не на паузе. */
export async function selectDueSources(q: Queryable, now: Date): Promise<string[]> {
  const r = await q.query<{ id: string; cron: string; last_run_at: Date | null; error_count: number }>(
    `SELECT s.id, s.cron, s.last_run_at, s.error_count
       FROM sources s
      WHERE s.status IN ('active', 'error')
        AND EXISTS (SELECT 1 FROM source_configs c
                     WHERE c.source_id = s.id AND c.is_active AND c.config->>'type' IN ('rss', 'html_list'))
      ORDER BY s.last_run_at NULLS FIRST`,
  );
  return r.rows
    .filter(
      (s) => !s.last_run_at || nextRunAt(s.last_run_at, s.cron, s.error_count).getTime() <= now.getTime(),
    )
    .map((s) => s.id);
}
