const nf = new Intl.NumberFormat('ru-RU');
export const num = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : nf.format(n));
export const compact = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.0', '')} млн` : n >= 10_000 ? `${Math.round(n / 1000)} тыс.` : nf.format(n));
export const money = (minor: number | null, currency = 'RUB'): string =>
  minor === null ? 'по запросу' : new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);

export function timeAgo(date: string | Date, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(date).getTime()) / 1000));
  if (s < 60) return `${s} сек назад`;
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return `${Math.floor(s / 86400)} дн назад`;
}
export const dateTime = (d: string | Date) => new Date(d).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const dateShort = (d: string | Date) => new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
export const sizeLabel = (bytes: number | null) => (bytes === null ? '—' : bytes > 1_000_000 ? `${(bytes / 1_000_000).toFixed(1).replace('.', ',')} МБ` : `${Math.round(bytes / 1000)} КБ`);
export const sentimentScore = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2).replace('.', ',')}`);
export const pctDelta = (d: number | null) => (d === null ? null : `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toFixed(1).replace('.', ',')}%`);

/** Человекочитаемое расписание из cron-строки; нераспознанное возвращается как есть. */
export function cronLabel(cron: string): string {
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = p;
  if (dom !== '*' || mon !== '*' || dow !== '*') return cron;
  if (min === '*' && hour === '*') return 'каждую минуту';
  const everyMin = /^\*\/(\d+)$/.exec(min!);
  if (everyMin && hour === '*') return `каждые ${everyMin[1]} мин`;
  if (min === '0' && hour === '*') return 'каждый час';
  const everyHour = /^\*\/(\d+)$/.exec(hour!);
  if (/^\d+$/.test(min!) && everyHour) return `каждые ${everyHour[1]} ч`;
  if (/^\d+$/.test(min!) && /^\d+$/.test(hour!)) return `ежедневно в ${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}`;
  return cron;
}

/** Подпись bucket из API ('2026-10-01T14:00') для оси графика. */
export function bucketLabel(label: string, hourly: boolean): string {
  const d = new Date(label);
  return hourly ? `${String(d.getHours()).padStart(2, '0')}:00` : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
