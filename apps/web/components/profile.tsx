'use client';
import Link from 'next/link';
import { useMemo, type ReactNode } from 'react';
import { Badge, Card, Chart, Segmented, axisStyle, useChartTheme } from '@mediaradar/ui';
import { SentimentBadge } from '@/components/charts-common';
import { num, timeAgo } from '@/lib/format';
import type { ArticleCard } from '@/lib/types';

export const RANGES = ['7d', '30d', '90d'] as const;
export type Range = (typeof RANGES)[number];
export const RANGE_DAYS: Record<Range, number> = { '7d': 7, '30d': 30, '90d': 90 };

export function RangeSwitch({ value, onChange }: { value: Range; onChange: (v: Range) => void }) {
  return (
    <Segmented
      label="Период"
      value={value}
      onChange={onChange}
      options={[
        { value: '7d', label: '7 дней' },
        { value: '30d', label: '30 дней' },
        { value: '90d', label: '90 дней' },
      ]}
    />
  );
}

export function KpiCard({
  label,
  value,
  hint,
  color,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  color: string;
}) {
  return (
    <Card className="p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 font-mono text-[24px] font-extrabold tracking-tight" style={{ color }}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[12px] text-faint">{hint}</div>}
    </Card>
  );
}

const dayLabel = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export interface DayPoint {
  date: string;
  count: number;
  /** Сутки с полными данными (до начала сбора лента источника отдаёт лишь последние записи). */
  complete?: boolean;
  spike?: boolean;
}

/** Публикации по суткам; сутки с неполными данными бледные, всплески красные. */
export function DailyChart({ days, height = 240 }: { days: DayPoint[]; height?: number }) {
  const t = useChartTheme();
  const option = useMemo(
    () => ({
      grid: { left: 40, right: 12, top: 12, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (p: Array<{ dataIndex: number }>) => {
          const d = days[p[0]!.dataIndex]!;
          const note = d.spike
            ? '<br/><b style="color:#e11d48">всплеск</b>'
            : d.complete === false
              ? '<br/><span style="opacity:.7">данные неполные</span>'
              : '';
          return `${dayLabel(d.date)}<br/><b>${num(d.count)}</b> материалов${note}`;
        },
      },
      xAxis: {
        type: 'category',
        data: days.map((d) => dayLabel(d.date)),
        ...axisStyle(t),
        splitLine: { show: false },
      },
      yAxis: { type: 'value', minInterval: 1, ...axisStyle(t) },
      series: [
        {
          type: 'bar',
          barWidth: '72%',
          data: days.map((d) => ({
            value: d.count,
            itemStyle: {
              color: d.spike ? '#e11d48' : '#3363ff',
              opacity: d.complete === false ? 0.35 : 1,
              borderRadius: [3, 3, 0, 0],
            },
          })),
        },
      ],
    }),
    [days, t],
  );
  return <Chart option={option} height={height} label="Столбчатая диаграмма: публикации по суткам" />;
}

/** Активность по часам суток. */
export function HoursChart({ hours, height = 230 }: { hours: number[]; height?: number }) {
  const t = useChartTheme();
  const option = useMemo(() => {
    const max = Math.max(...hours, 1);
    return {
      grid: { left: 36, right: 8, top: 8, bottom: 24 },
      tooltip: {
        trigger: 'axis',
        formatter: (p: Array<{ name: string; value: number }>) =>
          `${p[0]!.name}:00 — ${num(p[0]!.value)} публикаций`,
      },
      xAxis: { type: 'category', data: hours.map((_, h) => h), ...axisStyle(t), splitLine: { show: false } },
      yAxis: { type: 'value', minInterval: 1, ...axisStyle(t) },
      series: [
        {
          type: 'bar',
          barWidth: '78%',
          data: hours.map((v) => ({
            value: v,
            itemStyle: { color: `rgba(51, 99, 255, ${0.18 + (v / max) * 0.82})`, borderRadius: [3, 3, 0, 0] },
          })),
        },
      ],
    };
  }, [hours, t]);
  return <Chart option={option} height={height} label="Столбчатая диаграмма активности по часам" />;
}

/** Облако слов заголовков; слово ведёт в ленту с поиском по нему. */
export function WordCloud({
  words,
  minHeight = 240,
}: {
  words: Array<{ word: string; count: number }>;
  minHeight?: number;
}) {
  const max = words[0]?.count ?? 1;
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 py-3"
      style={{ minHeight }}
      role="list"
      aria-label="Самые частые слова в заголовках"
    >
      {words.map((w) => (
        <Link
          role="listitem"
          key={w.word}
          href={`/feed?q=${encodeURIComponent(w.word)}`}
          title={`${w.count} упоминаний — открыть в ленте`}
          className="font-bold transition hover:text-accent"
          style={{ fontSize: 12 + (w.count / max) * 17, opacity: 0.45 + (w.count / max) * 0.55 }}
        >
          {w.word}
        </Link>
      ))}
      {!words.length && <span className="text-[13px] text-muted">Нет данных за период</span>}
    </div>
  );
}

/** Распределение тональности: полоса и список. Пока материалы не размечены — пояснение. */
export function ToneBlock({
  sentiment,
}: {
  sentiment: {
    total: number;
    avgScore: number | null;
    items: Array<{ key: string; label: string; color: string; count: number; share: number }>;
  };
}) {
  if (!sentiment.total)
    return <p className="py-6 text-center text-[12.5px] text-muted">Материалы за период ещё не размечены.</p>;
  return (
    <div>
      <div
        className="mb-3 flex h-3 overflow-hidden rounded-full bg-line"
        role="img"
        aria-label="Распределение тональности"
      >
        {sentiment.items.map((i) => (
          <div
            key={i.key}
            title={`${i.label}: ${i.count}`}
            style={{ width: `${i.share}%`, background: i.color }}
          />
        ))}
      </div>
      <ul className="space-y-1.5">
        {sentiment.items.map((i) => (
          <li key={i.key} className="flex items-center gap-2 text-[12px]">
            <span className="size-2.5 flex-none rounded-sm" style={{ background: i.color }} />
            <span className="flex-1 text-muted">{i.label}</span>
            <span className="font-mono font-semibold">{num(i.count)}</span>
            <span className="w-11 text-right font-mono text-[11px] text-faint">{Math.round(i.share)}%</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-faint">
        Разметка автоматическая, по словарям: точность ограничена.
      </p>
    </div>
  );
}

export interface RankItem {
  key: string;
  label: string;
  count: number;
  href?: string;
  color?: string;
  note?: string;
}

/** Рейтинг с полосками; строка может быть ссылкой. */
export function RankList({ items, empty }: { items: RankItem[]; empty: string }) {
  const max = items[0]?.count ?? 1;
  if (!items.length) return <p className="py-6 text-center text-[12.5px] text-muted">{empty}</p>;
  return (
    <ul className="space-y-3">
      {items.map((it) => {
        const label = (
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold">
            {it.color && <span className="size-2 flex-none rounded-sm" style={{ background: it.color }} />}
            <span className="truncate">{it.label}</span>
            {it.note && <span className="flex-none text-[11px] font-normal text-faint">{it.note}</span>}
          </span>
        );
        return (
          <li key={it.key}>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              {it.href ? (
                <Link href={it.href} className="min-w-0 hover:text-accent hover:underline">
                  {label}
                </Link>
              ) : (
                label
              )}
              <span className="flex-none font-mono text-[12px] text-muted">{num(it.count)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-700"
                style={{ width: `${(it.count / max) * 100}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const safeHref = (u: string) => (/^https?:\/\//i.test(u) ? u : '#');

/** Последние материалы: заголовок ведёт на оригинал. */
export function LatestList({ items, showSource = true }: { items: ArticleCard[]; showSource?: boolean }) {
  if (!items.length)
    return <p className="py-8 text-center text-[13px] text-muted">Нет материалов за период</p>;
  return (
    <ul className="divide-y divide-line">
      {items.map((a) => (
        <li key={a.id} className="flex items-start gap-3 py-3">
          <div className="min-w-0 flex-1">
            <a
              href={safeHref(a.url)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13.5px] font-semibold leading-snug hover:text-accent hover:underline"
            >
              {a.title}
            </a>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted">
              {showSource && (
                <>
                  <Link href={`/sources/${a.source.id}`} className="font-semibold hover:text-accent">
                    {a.source.name}
                  </Link>
                  <span aria-hidden>·</span>
                </>
              )}
              <span className="font-mono">{timeAgo(a.publishedAt)}</span>
              {a.topic && (
                <>
                  <span aria-hidden>·</span>
                  <span>{a.topic.name}</span>
                </>
              )}
              {a.sourceState === 'removed' && <Badge tone="warn">удалено на источнике</Badge>}
            </div>
          </div>
          {a.sentiment && <SentimentBadge label={a.sentiment.label} className="mt-0.5 flex-none" />}
        </li>
      ))}
    </ul>
  );
}
