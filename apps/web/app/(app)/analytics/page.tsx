'use client';
import { Suspense, useMemo } from 'react';
import useSWR from 'swr';
import { Card, Chart, Segmented, Skeleton, axisStyle, useChartTheme } from '@mediaradar/ui';
import { heatStyle } from '@/components/charts-common';
import { ErrorBox, PageHeader } from '@/components/page';
import { DailyChart, HoursChart, WordCloud } from '@/components/profile';
import { num } from '@/lib/format';
import { useUrlParam } from '@/lib/hooks';

const RANGES = ['7d', '30d', '90d'] as const;
type Range = (typeof RANGES)[number];

interface Overview {
  from: string;
  to: string;
  timezone: string;
  kpis: {
    articles: number;
    avgSentiment: number | null;
    uniquePersons: number;
    critical: number;
    sources: number;
    last24h: number;
    perDay: number | null;
  };
  dailyVolume: Array<{ date: string; count: number; complete: boolean; spike: boolean }>;
  sentimentIndex: Array<{ date: string; score: number; average: number }>;
  sourceComparison: Array<{
    id: string;
    name: string;
    domain: string;
    count: number;
    share: number;
    negativeShare: number | null;
    trust: number;
  }>;
  heatmap: {
    rows: Array<{ key: string; name: string; color: string }>;
    cols: Array<{ id: string; domain: string; name: string }>;
    cells: Array<{ topic: string; sourceId: string; count: number }>;
  };
  hours: number[];
  words: Array<{ word: string; count: number }>;
  insights: Array<{ kind: string; color: string; title: string; text: string }>;
}

function Analytics() {
  const [range, setRange] = useUrlParam<Range>('range', '30d', RANGES);
  const { data, error, mutate } = useSWR<Overview>(`/v1/analytics/overview?range=${range}`, {
    keepPreviousData: true,
  });
  const t = useChartTheme();

  const hasIncomplete = !!data?.dailyVolume.some((d) => !d.complete && d.count > 0);
  const hasTone = !!data?.sourceComparison.some((s) => s.negativeShare !== null);
  const hasHeat = !!data?.heatmap.cells.length;
  const hasSentiment = !!data?.sentimentIndex.length;

  const sentOption = useMemo(
    () =>
      data && {
        grid: { left: 40, right: 12, top: 12, bottom: 60 },
        tooltip: { trigger: 'axis' },
        legend: {
          bottom: 0,
          icon: 'circle',
          itemWidth: 8,
          itemHeight: 8,
          textStyle: { color: t.muted, fontSize: 11 },
        },
        xAxis: {
          type: 'category',
          data: data.sentimentIndex.map((p) =>
            new Date(p.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }),
          ),
          ...axisStyle(t),
          splitLine: { show: false },
        },
        yAxis: { type: 'value', min: -0.6, max: 0.6, ...axisStyle(t) },
        series: [
          {
            name: 'Индекс за день',
            type: 'line',
            smooth: 0.3,
            symbol: 'none',
            lineStyle: { width: 1, color: '#8394ab', opacity: 0.7 },
            data: data.sentimentIndex.map((p) => p.score),
          },
          {
            name: 'Скользящее среднее (3 дня)',
            type: 'line',
            smooth: 0.4,
            symbol: 'none',
            lineStyle: { width: 2.5, color: '#3363ff' },
            areaStyle: { color: '#3363ff', opacity: 0.1 },
            data: data.sentimentIndex.map((p) => p.average),
            markLine: {
              silent: true,
              symbol: 'none',
              lineStyle: { color: t.muted, type: 'dashed' },
              data: [{ yAxis: 0 }],
              label: { show: false },
            },
          },
        ],
      },
    [data, t],
  );

  const cmpOption = useMemo(
    () =>
      data && {
        grid: { left: 44, right: hasTone ? 44 : 12, top: 12, bottom: 90 },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          formatter: (p: Array<{ dataIndex: number }>) => {
            const s = data.sourceComparison[p[0]!.dataIndex]!;
            return `${s.name}<br/><b>${num(s.count)}</b> материалов · ${s.share}% потока${
              s.negativeShare === null ? '' : `<br/>негатива: ${s.negativeShare}%`
            }`;
          },
        },
        legend: {
          bottom: 0,
          icon: 'circle',
          itemWidth: 8,
          itemHeight: 8,
          textStyle: { color: t.muted, fontSize: 11 },
        },
        xAxis: {
          type: 'category',
          data: data.sourceComparison.map((s) => s.domain),
          axisLabel: { color: t.muted, fontSize: 10, rotate: 35, interval: 0 },
          axisLine: { lineStyle: { color: t.line } },
          axisTick: { show: false },
        },
        yAxis: [
          {
            type: 'value',
            name: 'материалов',
            nameTextStyle: { color: t.muted, fontSize: 10 },
            ...axisStyle(t),
          },
          ...(hasTone
            ? [
                {
                  type: 'value',
                  name: '% негатива',
                  min: 0,
                  max: 60,
                  nameTextStyle: { color: t.muted, fontSize: 10 },
                  ...axisStyle(t),
                  splitLine: { show: false },
                },
              ]
            : []),
        ],
        series: [
          {
            name: 'Материалов',
            type: 'bar',
            data: data.sourceComparison.map((s) => s.count),
            itemStyle: { color: t.dark ? '#6d93ff' : '#0f172a', borderRadius: [4, 4, 0, 0] },
          },
          ...(hasTone
            ? [
                {
                  name: 'Доля негатива, %',
                  type: 'bar',
                  yAxisIndex: 1,
                  data: data.sourceComparison.map((s) => s.negativeShare),
                  itemStyle: { color: '#f59e0b', borderRadius: [4, 4, 0, 0] },
                },
              ]
            : []),
        ],
      },
    [data, t, hasTone],
  );

  const cell = (topic: string, src: string) =>
    data?.heatmap.cells.find((c) => c.topic === topic && c.sourceId === src)?.count ?? 0;
  const heatMax = Math.max(1, ...(data?.heatmap.cells.map((c) => c.count) ?? [1]));

  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const kpis = data
    ? [
        {
          label: 'Охват публикаций',
          value: num(data.kpis.articles),
          hint: `за ${days} дней`,
          color: '#3363ff',
        },
        {
          label: 'Источников в потоке',
          value: num(data.kpis.sources),
          hint: 'дали материалы за период',
          color: '#059669',
        },
        {
          label: 'В среднем в сутки',
          value: data.kpis.perDay === null ? '—' : num(data.kpis.perDay),
          hint: data.kpis.perDay === null ? 'считается по полным суткам сбора' : 'по полным суткам сбора',
          color: '#8b5cf6',
        },
        {
          label: 'За последние 24 часа',
          value: num(data.kpis.last24h),
          hint: 'материалов',
          color: '#f59e0b',
        },
      ]
    : [];

  return (
    <div className="mr-fade-up">
      <PageHeader
        eyebrow="Аналитика"
        title="Отчёты и визуализация данных"
        actions={
          <Segmented
            label="Период"
            value={range}
            onChange={setRange}
            options={[
              { value: '7d', label: '7 дней' },
              { value: '30d', label: '30 дней' },
              { value: '90d', label: '90 дней' },
            ]}
          />
        }
      />
      {error && !data && <ErrorBox message={(error as Error).message} onRetry={() => void mutate()} />}
      {!data && !error && (
        <div className="grid gap-4 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      )}
      {data && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4 xl:grid-cols-4">
            {kpis.map((k) => (
              <Card key={k.label} className="p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{k.label}</div>
                <div
                  className="mt-1 font-mono text-[24px] font-extrabold tracking-tight"
                  style={{ color: k.color }}
                >
                  {k.value}
                </div>
                <div className="mt-0.5 text-[12px] text-faint">{k.hint}</div>
              </Card>
            ))}
          </div>
          <div className="mb-4 grid gap-4 xl:grid-cols-2">
            <Card className="p-5">
              <h2 className="text-[15px] font-bold">Публикации по суткам</h2>
              <p className="mb-4 text-[12px] text-muted">
                Число материалов в сутки · часовой пояс тенанта; красным отмечены всплески
              </p>
              <DailyChart days={data.dailyVolume} height={270} />
              {hasIncomplete && (
                <p className="mt-3 text-[11.5px] leading-relaxed text-faint">
                  Бледные столбцы — сутки, когда сбор ещё не шёл: источники отдают только последние записи,
                  поэтому данных там меньше, чем было на самом деле. Всплески ищутся только по полным суткам.
                </p>
              )}
            </Card>
            <Card className="p-5">
              <h2 className="text-[15px] font-bold">Сравнение источников</h2>
              <p className="mb-4 text-[12px] text-muted">
                Объём публикаций{hasTone ? ' и доля негатива' : ''}; в подсказке — доля общего потока
              </p>
              <Chart
                option={cmpOption!}
                height={270}
                label={`Сравнение источников: объём${hasTone ? ' и доля негатива' : ''}`}
              />
            </Card>
          </div>
          {hasSentiment ? (
            <Card className="mb-4 p-5">
              <h2 className="text-[15px] font-bold">Индекс тональности во времени</h2>
              <p className="mb-4 text-[12px] text-muted">
                Средний скор −1…+1 по дням · скользящее среднее за 3 дня
              </p>
              <Chart option={sentOption!} height={270} label="Линейный график индекса тональности" />
            </Card>
          ) : (
            <p className="mb-4 rounded-xl border border-dashed border-line px-4 py-3 text-[12.5px] text-muted">
              Индекс тональности и тепловая карта «тема × источник» появятся, когда материалы будут размечены
              по тональности и темам.
            </p>
          )}
          <div className="mb-4 grid gap-4 xl:grid-cols-3">
            {hasHeat && (
              <Card className="p-5 xl:col-span-2">
                <h2 className="text-[15px] font-bold">Тепловая карта «тема × источник»</h2>
                <p className="mb-4 text-[12px] text-muted">Число материалов по теме в источнике</p>
                <div className="overflow-x-auto">
                  <table className="border-separate border-spacing-0.5">
                    <thead>
                      <tr>
                        <th className="pr-2 pb-1 text-left text-[11px] font-bold uppercase tracking-wider text-faint">
                          Тема \ Источник
                        </th>
                        {data.heatmap.cols.map((c) => (
                          <th
                            key={c.id}
                            className="h-28 px-0.5 pb-1 align-bottom text-[11px] font-semibold text-muted"
                            title={c.name}
                          >
                            <div className="mx-auto max-h-28 truncate whitespace-nowrap [writing-mode:vertical-rl] rotate-180">
                              {c.domain}
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.heatmap.rows.map((r) => (
                        <tr key={r.key}>
                          <td className="whitespace-nowrap pr-2 text-[12px] font-semibold">
                            <span
                              className="mr-1.5 inline-block size-2 rounded-sm"
                              style={{ background: r.color }}
                            />
                            {r.name}
                          </td>
                          {data.heatmap.cols.map((c) => {
                            const v = cell(r.key, c.id);
                            return (
                              <td key={c.id} className="p-0">
                                <div
                                  className="grid h-8 min-w-8 place-items-center rounded font-mono text-[11px] font-bold transition hover:scale-105"
                                  style={heatStyle(v, heatMax)}
                                  title={`${r.name} · ${c.domain}: ${v}`}
                                >
                                  {v || ''}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
            <Card className={hasHeat ? 'p-5' : 'p-5 xl:col-span-3'}>
              <h2 className="text-[15px] font-bold">Облако тем</h2>
              <p className="mb-4 text-[12px] text-muted">Частотный анализ заголовков</p>
              <WordCloud words={data.words} />
            </Card>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card className="p-5">
              <h2 className="text-[15px] font-bold">Активность по часам суток</h2>
              <p className="mb-4 text-[12px] text-muted">Часовой пояс тенанта: {data.timezone}</p>
              <HoursChart hours={data.hours} />
            </Card>
            <Card className="p-5">
              <h2 className="mb-1 text-[15px] font-bold">Наблюдения за период</h2>
              <p className="mb-4 text-[12px] text-muted">
                Формируются автоматически по правилам; числа считаются по данным, AI-пояснения — Фаза 5
              </p>
              <ul className="space-y-3">
                {data.insights.map((i) => (
                  <li
                    key={i.title}
                    className="flex gap-3 rounded-xl border border-line p-3 transition hover:bg-surface-2"
                  >
                    <span className="w-1 flex-none rounded-full" style={{ background: i.color }} />
                    <div className="min-w-0">
                      <div className="mb-0.5 flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-bold">{i.title}</span>
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                          style={{ background: `${i.color}22`, color: i.color }}
                        >
                          {i.kind}
                        </span>
                      </div>
                      <p className="text-[12.5px] leading-relaxed text-muted">{i.text}</p>
                    </div>
                  </li>
                ))}
                {!data.insights.length && (
                  <li className="py-8 text-center text-[13px] text-muted">
                    Недостаточно данных для наблюдений
                  </li>
                )}
              </ul>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
export default function Page() {
  return (
    <Suspense>
      <Analytics />
    </Suspense>
  );
}
