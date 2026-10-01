'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import useSWR from 'swr';
import { SOURCE_KINDS } from '@mediaradar/core/domain';
import { Badge, Card, Skeleton } from '@mediaradar/ui';
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
import { num, timeAgo } from '@/lib/format';
import { useUrlParam } from '@/lib/hooks';
import type { ArticleCard } from '@/lib/types';

interface SourceProfile {
  source: {
    id: string;
    name: string;
    domain: string;
    url: string;
    kind: keyof typeof SOURCE_KINDS;
    status: 'active' | 'paused' | 'error' | 'needs_attention';
    trust: number;
    lastRunAt: string | null;
    itemsCount: number;
    firstPublishedAt: string | null;
  };
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
  words: Array<{ word: string; count: number }>;
  entities: Array<{ id: string; name: string; type: string; count: number }>;
  latest: ArticleCard[];
}

const STATUS = {
  active: ['ok', 'работает'],
  error: ['bad', 'ошибка'],
  needs_attention: ['warn', 'нужно внимание'],
  paused: ['neutral', 'пауза'],
} as const;
const MIN_PREV_FOR_DELTA = 30;
const safeHref = (u: string) => (/^https?:\/\//i.test(u) ? u : '#');

function Profile() {
  const { id } = useParams<{ id: string }>();
  const [range, setRange] = useUrlParam<Range>('range', '30d', RANGES);
  const { data, error, mutate } = useSWR<SourceProfile>(`/v1/sources/${id}/profile?range=${range}`, {
    keepPreviousData: true,
  });
  if (error && !data)
    return (
      <div className="mr-fade-up">
        <PageHeader eyebrow="Источник" title="Источник не найден" />
        <ErrorBox message={(error as Error).message} onRetry={() => void mutate()} />
        <Link
          href="/sources"
          className="mt-4 inline-block text-[13px] font-semibold text-accent hover:underline"
        >
          ← К реестру источников
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

  const s = data.source;
  const [tone, statusText] = STATUS[s.status];
  // «в среднем в сутки» считаем по дням, за которые у нас вообще есть материалы источника, а не по всему периоду
  const spanDays = s.firstPublishedAt
    ? Math.max(
        1,
        Math.min(RANGE_DAYS[range], Math.ceil((Date.now() - Date.parse(s.firstPublishedAt)) / 864e5)),
      )
    : RANGE_DAYS[range];
  const delta =
    data.prevTotal < MIN_PREV_FOR_DELTA
      ? null
      : Math.round(((data.total - data.prevTotal) / data.prevTotal) * 1000) / 10;
  const last = data.latest[0];

  return (
    <div className="mr-fade-up">
      <PageHeader
        eyebrow="Источник"
        title={s.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <a
              href={safeHref(s.url)}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono hover:text-accent hover:underline"
            >
              {s.domain}
            </a>
            <span aria-hidden>·</span>
            <span>{SOURCE_KINDS[s.kind]}</span>
            <Badge tone={tone}>{statusText}</Badge>
            <span aria-hidden>·</span>
            <span>доверие {s.trust}%</span>
            {s.lastRunAt && (
              <>
                <span aria-hidden>·</span>
                <span>последний сбор {timeAgo(s.lastRunAt)}</span>
              </>
            )}
          </span>
        }
        actions={
          <>
            <Link
              href={`/feed?sources=${s.id}`}
              className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-semibold hover:bg-surface-2"
            >
              Все материалы в ленте
            </Link>
            <RangeSwitch value={range} onChange={setRange} />
          </>
        }
      />
      <Link
        href="/sources"
        className="-mt-3 mb-4 inline-block text-[12.5px] font-semibold text-accent hover:underline"
      >
        ← К реестру источников
      </Link>

      <div className="mb-4 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiCard
          label="Материалов за период"
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
          label="В среднем в сутки"
          value={num(Math.round(data.total / spanDays))}
          hint={`за ${spanDays} ${spanDays === 1 ? 'сутки' : 'сут.'} наблюдения`}
          color="#8b5cf6"
        />
        <KpiCard
          label="Последний материал"
          value={<span className="text-[18px]">{last ? timeAgo(last.publishedAt) : '—'}</span>}
          hint={`всего собрано: ${num(s.itemsCount)}`}
          color="#f59e0b"
        />
      </div>

      <div className="mb-4 grid gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-2">
          <h2 className="text-[15px] font-bold">Публикации по суткам</h2>
          <p className="mb-4 text-[12px] text-muted">Часовой пояс тенанта: {data.timezone}</p>
          <DailyChart days={data.daily} />
        </Card>
        <Card className="p-5">
          <h2 className="text-[15px] font-bold">Тональность</h2>
          <p className="mb-4 text-[12px] text-muted">Как источник пишет в среднем</p>
          <ToneBlock sentiment={data.sentiment} />
        </Card>
      </div>

      <div className="mb-4 grid gap-4 xl:grid-cols-3">
        <Card className="p-5">
          <h2 className="mb-4 text-[15px] font-bold">О чём пишет</h2>
          <RankList
            empty="Темы материалов ещё не определены"
            items={data.topics.map((t) => ({
              key: t.key,
              label: t.name,
              count: t.count,
              color: t.color,
              href: `/feed?sources=${s.id}&topics=${t.key}`,
            }))}
          />
        </Card>
        <Card className="p-5">
          <h2 className="mb-4 text-[15px] font-bold">Кого упоминает</h2>
          <RankList
            empty="Персон и организаций из словаря пока не найдено"
            items={data.entities.map((e) => ({
              key: e.id,
              label: e.name,
              count: e.count,
              href: `/entities/${e.id}`,
              note: e.type === 'org' ? 'орг.' : undefined,
            }))}
          />
        </Card>
        <Card className="p-5">
          <h2 className="text-[15px] font-bold">Активность по часам</h2>
          <p className="mb-2 text-[12px] text-muted">Когда источник публикует</p>
          <HoursChart hours={data.hours} height={190} />
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="p-5">
          <h2 className="text-[15px] font-bold">Что обсуждает</h2>
          <p className="mb-2 text-[12px] text-muted">Частые слова заголовков</p>
          <WordCloud words={data.words} minHeight={180} />
        </Card>
        <Card className="p-5 xl:col-span-2">
          <h2 className="mb-1 text-[15px] font-bold">Последние материалы</h2>
          <LatestList items={data.latest} showSource={false} />
        </Card>
      </div>
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
