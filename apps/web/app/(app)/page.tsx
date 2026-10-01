'use client';
import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { Badge, Card, Chart, Segmented, Skeleton, Sparkline, axisStyle, cn, useChartTheme } from '@mediaradar/ui';
import { SENTIMENTS } from '@mediaradar/core/domain';
import { Delta, SentimentBadge, heatStyle } from '@/components/charts-common';
import { ErrorBox, PageHeader } from '@/components/page';
import { bucketLabel, num, timeAgo } from '@/lib/format';
import { useUrlParam } from '@/lib/hooks';
import { useLive, type LiveArticle } from '@/lib/live';
import { useMe } from '@/lib/me';
import type { ArticlePage } from '@/lib/types';

const RANGES = ['24h', '7d', '30d', '90d'] as const;
type Range = (typeof RANGES)[number];

interface Dash {
  from: string; to: string; timezone: string; bucket: 'hour' | 'day';
  kpis: Array<{ key: string; label: string; value: number; hint?: string; delta: number | null; goodWhenUp: boolean; spark: number[] | null }>;
  sentiment: { total: number; items: Array<{ key: keyof typeof SENTIMENTS; label: string; short: string; color: string; count: number; share: number }> };
  volume: { labels: string[]; series: Array<{ key: string; name: string; color: string; data: number[] }> };
  topSources: Array<{ id: string; name: string; domain: string; count: number }>;
  geo: { places: Array<{ id: string; name: string; level: string; count: number }>; total: number };
  persons: { top: Array<{ name: string; count: number }>; total: number };
  health: { parsers: Array<{ parser: string; sources: number; errors: number; paused: number; failingDomain: string | null; maxErrors: number }>; sources: { active: number; errors: number; paused: number }; queue: { waiting: number; active: number; delayed: number; failed: number; available: boolean } };
}

const SPARK_COLORS: Record<string, string> = { articles: '#3363ff', sources: '#059669', negative: '#e11d48', alerts: '#f59e0b' };

function Kpis({ data }: { data: Dash }) {
  return (
    <div className="mb-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
      {data.kpis.map((k) => (
        <Card key={k.key} className="p-4">
          <div className="mb-2 flex items-start justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase leading-tight tracking-wide text-muted">{k.label}</span>
            <Delta value={k.delta} goodWhenUp={k.goodWhenUp} />
          </div>
          <div className="font-mono text-[26px] font-extrabold leading-none tracking-tight">{num(k.value)}</div>
          {k.hint && <div className="mt-1 text-[11px] text-faint">{k.hint}</div>}
          {k.spark ? <div className="mt-2"><Sparkline data={k.spark} color={SPARK_COLORS[k.key] ?? '#3363ff'} label={`Динамика: ${k.label}`} /></div> : <div className="mt-2 h-[34px]" />}
        </Card>
      ))}
    </div>
  );
}

function LiveTicker() {
  const { data } = useSWR<ArticlePage>('/v1/articles?limit=9');
  const { subscribe, status } = useLive();
  const [live, setLive] = useState<LiveArticle[]>([]);
  useEffect(() => subscribe((a) => setLive((x) => [a, ...x].slice(0, 9))), [subscribe]);
  const rows = useMemo(() => {
    const fresh = live.map((a) => ({ id: a.id, title: a.title, source: a.source.name, geo: a.geo, publishedAt: a.publishedAt, label: a.sentiment.label, topic: a.topic, isLive: true }));
    const base = (data?.items ?? []).filter((i) => !live.some((l) => l.id === i.id)).map((i) => ({ id: i.id, title: i.title, source: i.source.name, geo: i.geo, publishedAt: i.publishedAt, label: i.sentiment?.label ?? 'N', topic: i.topic?.key ?? '', isLive: false }));
    return [...fresh, ...base].slice(0, 9);
  }, [live, data]);
  return (
    <Card className="overflow-hidden xl:col-span-2">
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className={cn('size-2 rounded-full', status === 'live' ? 'mr-pulse bg-ok' : 'bg-faint')} />
          <h2 className="text-[15px] font-bold">Поток в реальном времени</h2>
          <Badge tone="accent">WebSocket</Badge>
        </div>
        <Link href="/feed" className="text-[12px] font-semibold text-accent hover:underline">Вся лента →</Link>
      </div>
      <ul className="max-h-[352px] divide-y divide-line overflow-y-auto" aria-live="off">
        {!data && Array.from({ length: 5 }, (_, i) => <li key={i} className="px-5 py-3"><Skeleton className="h-10" /></li>)}
        {rows.map((r) => (
          <li key={r.id} className={cn('border-l-2 px-5 py-3 transition hover:bg-surface-2', r.isLive && 'mr-slide-in')} style={{ borderColor: SENTIMENTS[r.label].hex }}>
            <Link href={`/feed?q=${encodeURIComponent(r.title)}`} className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold leading-snug">{r.title}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted">
                  <span className="font-semibold">{r.source}</span>{r.geo && <><span aria-hidden>·</span><span>{r.geo}</span></>}<span aria-hidden>·</span><span className="font-mono">{timeAgo(r.publishedAt)}</span>
                </div>
              </div>
              <SentimentBadge label={r.label} className="mt-0.5 flex-none" />
            </Link>
          </li>
        ))}
        {data && !rows.length && <li className="px-5 py-10 text-center text-[13px] text-muted">Пока нет материалов</li>}
      </ul>
    </Card>
  );
}

function SentimentCard({ data }: { data: Dash }) {
  const option = useMemo(() => ({
    tooltip: { trigger: 'item', formatter: (p: { name: string; value: number; percent: number }) => `${p.name}: ${num(p.value)} (${p.percent}%)` },
    series: [{ type: 'pie', radius: ['66%', '92%'], avoidLabelOverlap: false, label: { show: false }, itemStyle: { borderWidth: 2, borderColor: 'transparent' }, data: data.sentiment.items.map((i) => ({ name: i.short, value: i.count, itemStyle: { color: i.color } })) }],
  }), [data]);
  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center justify-between"><h2 className="text-[15px] font-bold">Тональность</h2><Badge>{num(data.sentiment.total)} матер.</Badge></div>
      <p className="mb-3 text-[12px] text-muted">Распределение за выбранный период</p>
      <Chart option={option} height={176} label="Круговая диаграмма тональности материалов" />
      <ul className="mt-4 space-y-2 border-t border-line pt-4">
        {data.sentiment.items.map((i) => (
          <li key={i.key} className="flex items-center gap-2 text-[12px]">
            <span className="size-2.5 flex-none rounded-sm" style={{ background: i.color }} />
            <span className="flex-1 text-muted">{i.label}</span>
            <span className="font-mono font-semibold">{num(i.count)}</span>
            <span className="w-11 text-right font-mono text-[11px] text-faint">{Math.round(i.share)}%</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function VolumeCard({ data }: { data: Dash }) {
  const t = useChartTheme();
  const hourly = data.bucket === 'hour';
  const option = useMemo(() => ({
    grid: { left: 36, right: 8, top: 8, bottom: 56 },
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: t.muted, fontSize: 11 } },
    xAxis: { type: 'category', boundaryGap: false, data: data.volume.labels.map((l) => bucketLabel(l, hourly)), ...axisStyle(t), splitLine: { show: false } },
    yAxis: { type: 'value', ...axisStyle(t) },
    series: data.volume.series.map((s) => ({ name: s.name, type: 'line', stack: 'all', smooth: 0.35, symbol: 'none', lineStyle: { width: 1.5, color: s.color }, areaStyle: { color: s.color, opacity: 0.18 }, itemStyle: { color: s.color }, emphasis: { focus: 'series' }, data: s.data })),
  }), [data, t, hourly]);
  return (
    <Card className="p-5 xl:col-span-2">
      <h2 className="text-[15px] font-bold">Динамика публикаций по темам</h2>
      <p className="mb-3 text-[12px] text-muted">Стековые области · {hourly ? 'по часам' : 'по дням'} · часовой пояс тенанта ({data.timezone})</p>
      <Chart option={option} height={270} label="График динамики публикаций по темам" />
    </Card>
  );
}

function TopSourcesCard({ data }: { data: Dash }) {
  const t = useChartTheme();
  const items = [...data.topSources].reverse();
  const option = useMemo(() => ({
    grid: { left: 8, right: 16, top: 4, bottom: 4, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (p: Array<{ name: string; value: number }>) => `${p[0]!.name}<br/><b>${num(p[0]!.value)}</b> материалов` },
    xAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, fontSize: 11 } },
    yAxis: { type: 'category', data: items.map((s) => s.domain), ...axisStyle(t), splitLine: { show: false }, axisLabel: { color: t.fg, fontSize: 11, width: 110, overflow: 'truncate' } },
    series: [{ type: 'bar', data: items.map((s) => s.count), barWidth: 14, itemStyle: { color: t.dark ? '#6d93ff' : '#0f172a', borderRadius: [0, 4, 4, 0] } }],
  }), [items, t]);
  return (
    <Card className="p-5">
      <h2 className="text-[15px] font-bold">Топ источников</h2>
      <p className="mb-3 text-[12px] text-muted">По объёму материалов</p>
      {items.length ? <Chart option={option} height={270} label="Столбчатая диаграмма: топ источников по объёму" /> : <p className="py-16 text-center text-[13px] text-muted">Нет данных за период</p>}
    </Card>
  );
}

function GeoCard({ data }: { data: Dash }) {
  const places = data.geo.places;
  const max = places[0]?.count ?? 0;
  const top = places.slice(0, 4);
  const rest = places.slice(4).reduce((s, p) => s + p.count, 0);
  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center justify-between"><h2 className="text-[15px] font-bold">Гео-распределение</h2><Badge>{places.length} терр.</Badge></div>
      <p className="mb-4 text-[12px] text-muted">Интенсивность инфоповодов по территории</p>
      <div className="mb-4 grid grid-cols-9 gap-1" role="img" aria-label="Тепловая плитка территорий по числу материалов">
        {places.slice(0, 36).map((p) => (
          <div key={p.id} title={`${p.name}: ${num(p.count)}`} className="grid aspect-square place-items-center rounded-[5px] text-[10px] font-bold transition hover:scale-110" style={heatStyle(p.count, max)}>{p.name.slice(0, 2)}</div>
        ))}
      </div>
      <ul className="space-y-2">
        {top.map((p, i) => (
          <li key={p.id} className="flex items-center gap-2 text-[12px]">
            <span className="size-2.5 flex-none rounded-sm" style={{ background: `color-mix(in srgb, var(--accent) ${100 - i * 22}%, var(--surface))` }} />
            <span className="flex-1 text-muted">{p.name}</span><span className="font-mono font-semibold">{num(p.count)}</span>
          </li>
        ))}
        {rest > 0 && <li className="flex items-center gap-2 text-[12px]"><span className="size-2.5 flex-none rounded-sm bg-line-strong" /><span className="flex-1 text-muted">Прочие территории</span><span className="font-mono font-semibold">{num(rest)}</span></li>}
      </ul>
    </Card>
  );
}

function PersonsCard({ data }: { data: Dash }) {
  const max = data.persons.top[0]?.count ?? 1;
  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center justify-between"><h2 className="text-[15px] font-bold">Персоны (NER)</h2><Badge tone="ok">{num(data.persons.total)} сущн.</Badge></div>
      <p className="mb-4 text-[12px] text-muted">Упоминания в материалах за период</p>
      <ul className="space-y-3">
        {data.persons.top.map((p, i) => (
          <li key={p.name}>
            <div className="mb-1 flex items-baseline justify-between"><span className="text-[13px] font-semibold">{i + 1}. {p.name}</span><span className="font-mono text-[12px] text-muted">{num(p.count)} упом.</span></div>
            <div className="h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-700" style={{ width: `${(p.count / max) * 100}%` }} /></div>
          </li>
        ))}
        {!data.persons.top.length && <li className="py-8 text-center text-[13px] text-muted">Нет данных за период</li>}
      </ul>
      <p className="mt-4 text-[11px] text-faint">Сущности в демо-режиме заданы синтетически; автоматическое извлечение (NER) подключается в Фазе 3.</p>
    </Card>
  );
}

function HealthCard({ data }: { data: Dash }) {
  const q = data.health.queue;
  return (
    <Card className="p-5">
      <h2 className="text-[15px] font-bold">Состояние парсеров</h2>
      <p className="mb-4 text-[12px] text-muted">{q.available ? 'Очередь BullMQ подключена' : 'Очередь недоступна'} · сбор данных — Фаза 1</p>
      <ul className="space-y-3">
        {data.health.parsers.map((p) => {
          const bad = p.errors > 0;
          return (
            <li key={p.parser} className="flex items-center gap-2.5">
              <span className={cn('size-2 flex-none rounded-full', bad ? 'bg-bad' : p.paused ? 'bg-warn' : 'bg-ok')} />
              <span className="w-[116px] flex-none truncate font-mono text-[12px] font-semibold">{p.parser.toLowerCase()}</span>
              <span className="flex-1 truncate text-[12px] text-muted">{bad && p.failingDomain ? `${p.failingDomain} · ${p.maxErrors} попыток` : `${p.sources} ист.${p.paused ? ` · пауза: ${p.paused}` : ''}`}</span>
              <Badge tone={bad ? 'bad' : p.paused ? 'warn' : 'neutral'}>{bad ? 'Ошибка' : p.paused ? 'Пауза' : 'Работает'}</Badge>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-4 text-center">
        {[[q.waiting + q.active + q.delayed, 'в очереди', ''], [data.health.sources.active, 'работают', 'text-ok'], [data.health.sources.errors, 'ошибки', data.health.sources.errors ? 'text-bad' : '']].map(([v, l, c]) => (
          <div key={String(l)}><div className={cn('font-mono text-[18px] font-extrabold', String(c))}>{num(Number(v))}</div><div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{l}</div></div>
        ))}
      </div>
    </Card>
  );
}

function Dashboard() {
  const { me } = useMe();
  const [range, setRange] = useUrlParam<Range>('range', '7d', RANGES);
  const { data, error, mutate } = useSWR<Dash>(`/v1/dashboard?range=${range}`, { keepPreviousData: true, refreshInterval: 60_000 });
  const tz = data?.timezone ?? me.tenant?.regionProfile.timezone ?? 'Europe/Moscow';
  const today = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz });
  return (
    <div className="mr-fade-up">
      <PageHeader eyebrow={`Обзор · ${today}`} title={`Медиаландшафт: ${me.tenant?.name ?? ''}`}
        subtitle={data ? `${num(data.health.sources.active)} активных источников · ${num(data.kpis[0]?.value)} материалов за период · данные обновляются автоматически` : 'Загрузка…'}
        actions={<Segmented label="Период" value={range} onChange={setRange} options={[{ value: '24h', label: '24ч' }, { value: '7d', label: '7 дней' }, { value: '30d', label: '30 дней' }, { value: '90d', label: '90 дней' }]} />} />
      {error && !data && <ErrorBox message={(error as Error).message} onRetry={() => void mutate()} />}
      {!data && !error && <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-32" />)}</div>}
      {data && (
        <>
          <Kpis data={data} />
          <div className="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-3"><LiveTicker /><SentimentCard data={data} /></div>
          <div className="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-3"><VolumeCard data={data} /><TopSourcesCard data={data} /></div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3"><GeoCard data={data} /><PersonsCard data={data} /><HealthCard data={data} /></div>
        </>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense><Dashboard /></Suspense>;
}
