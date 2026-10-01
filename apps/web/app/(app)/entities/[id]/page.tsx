'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import useSWR from 'swr';
import { Card, Skeleton } from '@mediaradar/ui';
import { Delta } from '@/components/charts-common';
import { ErrorBox, PageHeader } from '@/components/page';
import {
  DailyChart,
  HoursChart,
  KpiCard,
  LatestList,
  RANGES,
  RANGE_DAYS,
  RangeSwitch,
  RankList,
  ToneBlock,
  WordCloud,
  type Range,
} from '@/components/profile';
import { num, sentimentScore } from '@/lib/format';
import { useUrlParam } from '@/lib/hooks';
import type { ArticleCard } from '@/lib/types';

interface EntityProfile {
  entity: { id: string; type: 'person' | 'org' | 'place' | 'event'; name: string };
  total: number;
  prevTotal: number;
  share: number | null;
  timezone: string;
  daily: Array<{ date: string; count: number }>;
  hours: number[];
  sentiment: {
    total: number;
    avgScore: number | null;
    items: Array<{ key: string; label: string; color: string; count: number; share: number }>;
  };
  topics: Array<{ key: string; name: string; color: string; count: number }>;
  sources: Array<{ id: string; name: string; domain: string; count: number }>;
  words: Array<{ word: string; count: number }>;
  related: Array<{ id: string; name: string; type: string; count: number }>;
  latest: ArticleCard[];
}

const TYPE_LABEL = { person: 'Персона', org: 'Организация', place: 'Место', event: 'Событие' } as const;
const MIN_PREV_FOR_DELTA = 30;

function Profile() {
  const { id } = useParams<{ id: string }>();
  const [range, setRange] = useUrlParam<Range>('range', '30d', RANGES);
  const { data, error, mutate } = useSWR<EntityProfile>(`/v1/entities/${id}/profile?range=${range}`, {
    keepPreviousData: true,
  });
  if (error && !data)
    return (
      <div className="mr-fade-up">
        <PageHeader eyebrow="Персоны и организации" title="Не найдено" />
        <ErrorBox message={(error as Error).message} onRetry={() => void mutate()} />
        <Link
          href="/entities"
          className="mt-4 inline-block text-[13px] font-semibold text-accent hover:underline"
        >
          ← К списку
        </Link>
      </div>
    );
  if (!data)
    return (
      <div className="grid gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );

  const e = data.entity;
  const delta =
    data.prevTotal < MIN_PREV_FOR_DELTA
      ? null
      : Math.round(((data.total - data.prevTotal) / data.prevTotal) * 1000) / 10;
  const avg = data.sentiment.avgScore;

  return (
    <div className="mr-fade-up">
      <PageHeader
        eyebrow={TYPE_LABEL[e.type]}
        title={e.name}
        subtitle="Упоминания в собранных материалах: словарный поиск по заголовку и лиду"
        actions={
          <>
            <Link
              href={`/feed?q=${encodeURIComponent(e.name)}`}
              className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-semibold hover:bg-surface-2"
            >
              Все материалы в ленте
            </Link>
            <RangeSwitch value={range} onChange={setRange} />
          </>
        }
      />
      <Link
        href={`/entities?type=${e.type}`}
        className="-mt-3 mb-4 inline-block text-[12.5px] font-semibold text-accent hover:underline"
      >
        ← К списку
      </Link>

      <div className="mb-4 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiCard
          label="Материалов с упоминанием"
          value={
            <span className="flex items-center gap-2">
              {num(data.total)}
              <Delta value={delta} goodWhenUp />
            </span>
          }
          hint={`за ${RANGE_DAYS[range]} дней`}
          color="#3363ff"
        />
        <KpiCard
          label="Доля потока"
          value={data.share === null ? '—' : `${String(data.share).replace('.', ',')}%`}
          hint="от всех материалов тенанта"
          color="#059669"
        />
        <KpiCard
          label="Средняя тональность"
          value={sentimentScore(avg)}
          hint={
            avg === null
              ? 'нет размеченных материалов'
              : avg > 0.1
                ? 'скорее позитивный фон'
                : avg < -0.1
                  ? 'скорее негативный фон'
                  : 'нейтральный фон'
          }
          color="#8b5cf6"
        />
        <KpiCard
          label="Источников"
          value={num(data.sources.length)}
          hint="писали об этом (топ-8 ниже)"
          color="#f59e0b"
        />
      </div>

      <div className="mb-4 grid gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-2">
          <h2 className="text-[15px] font-bold">Упоминания по суткам</h2>
          <p className="mb-4 text-[12px] text-muted">Часовой пояс тенанта: {data.timezone}</p>
          <DailyChart days={data.daily} />
        </Card>
        <Card className="p-5">
          <h2 className="text-[15px] font-bold">Тональность материалов</h2>
          <p className="mb-4 text-[12px] text-muted">Тон материала, а не отношение к персоне лично</p>
          <ToneBlock sentiment={data.sentiment} />
        </Card>
      </div>

      <div className="mb-4 grid gap-4 xl:grid-cols-3">
        <Card className="p-5">
          <h2 className="mb-4 text-[15px] font-bold">Кто пишет</h2>
          <RankList
            empty="Нет данных за период"
            items={data.sources.map((x) => ({
              key: x.id,
              label: x.name,
              count: x.count,
              href: `/sources/${x.id}`,
            }))}
          />
        </Card>
        <Card className="p-5">
          <h2 className="mb-4 text-[15px] font-bold">В каких темах</h2>
          <RankList
            empty="Темы материалов ещё не определены"
            items={data.topics.map((t) => ({
              key: t.key,
              label: t.name,
              count: t.count,
              color: t.color,
              href: `/feed?q=${encodeURIComponent(e.name)}&topics=${t.key}`,
            }))}
          />
        </Card>
        <Card className="p-5">
          <h2 className="mb-4 text-[15px] font-bold">Упоминается вместе с</h2>
          <RankList
            empty="Других персон и организаций рядом не найдено"
            items={data.related.map((x) => ({
              key: x.id,
              label: x.name,
              count: x.count,
              href: `/entities/${x.id}`,
              note: x.type === 'org' ? 'орг.' : undefined,
            }))}
          />
        </Card>
      </div>

      <div className="mb-4 grid gap-4 xl:grid-cols-3">
        <Card className="p-5">
          <h2 className="text-[15px] font-bold">Что обсуждают рядом</h2>
          <p className="mb-2 text-[12px] text-muted">Частые слова заголовков с упоминанием</p>
          <WordCloud words={data.words} minHeight={180} />
        </Card>
        <Card className="p-5 xl:col-span-2">
          <h2 className="mb-1 text-[15px] font-bold">Последние материалы</h2>
          <LatestList items={data.latest} />
        </Card>
      </div>
      <Card className="p-5 xl:w-1/2">
        <h2 className="text-[15px] font-bold">Активность по часам</h2>
        <p className="mb-2 text-[12px] text-muted">Когда выходят материалы с упоминанием</p>
        <HoursChart hours={data.hours} height={190} />
      </Card>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Profile />
    </Suspense>
  );
}
