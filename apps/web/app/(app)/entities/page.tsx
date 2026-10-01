'use client';
import Link from 'next/link';
import { Suspense, useDeferredValue, useState } from 'react';
import useSWR from 'swr';
import { Card, Input, Skeleton, Tabs } from '@mediaradar/ui';
import { ErrorBox, PageHeader } from '@/components/page';
import { RANGES, RangeSwitch, type Range } from '@/components/profile';
import { num, sentimentScore } from '@/lib/format';
import { useUrlParam } from '@/lib/hooks';

const TYPES = ['person', 'org'] as const;
type EntityType = (typeof TYPES)[number];

interface EntityList {
  type: EntityType;
  items: Array<{ id: string; name: string; count: number; avgSentiment: number | null }>;
}

function Entities() {
  const [range, setRange] = useUrlParam<Range>('range', '30d', RANGES);
  const [type, setType] = useUrlParam<EntityType>('type', 'person', TYPES);
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q.trim());
  const { data, error, mutate } = useSWR<EntityList>(
    `/v1/entities?type=${type}&range=${range}${dq ? `&q=${encodeURIComponent(dq)}` : ''}`,
    { keepPreviousData: true },
  );
  const max = data?.items[0]?.count ?? 1;
  return (
    <div className="mr-fade-up">
      <PageHeader
        eyebrow="Аналитика"
        title="Персоны и организации"
        subtitle="Кого и что чаще всего упоминают. Распознаём по словарю публичных лиц и организаций, словарь пополняется."
        actions={<RangeSwitch value={range} onChange={setRange} />}
      />
      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Tabs
            value={type}
            onChange={setType}
            options={[
              { value: 'person', label: 'Персоны' },
              { value: 'org', label: 'Организации' },
            ]}
          />
          <Input
            aria-label="Поиск по имени или названию"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Поиск по имени…"
            className="ml-auto !w-64 !bg-surface-2 !py-1.5 !text-[12px]"
          />
        </div>
        {error && !data && <ErrorBox message={(error as Error).message} onRetry={() => void mutate()} />}
        {!data && !error && <Skeleton className="h-64" />}
        {data && (
          <ul className="divide-y divide-line">
            {data.items.map((e, i) => (
              <li key={e.id}>
                <Link
                  href={`/entities/${e.id}?range=${range}`}
                  className="flex items-center gap-3 py-2.5 hover:bg-surface-2"
                >
                  <span className="w-6 text-right font-mono text-[12px] text-faint">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold">{e.name}</span>
                    <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-line">
                      <span
                        className="block h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-700"
                        style={{ width: `${(e.count / max) * 100}%` }}
                      />
                    </span>
                  </span>
                  <span className="w-20 text-right font-mono text-[12.5px] text-muted">
                    {num(e.count)} матер.
                  </span>
                  <span
                    className="w-14 text-right font-mono text-[12px] text-faint"
                    title="Средняя тональность материалов с упоминанием"
                  >
                    {sentimentScore(e.avgSentiment)}
                  </span>
                </Link>
              </li>
            ))}
            {!data.items.length && (
              <li className="py-10 text-center text-[13px] text-muted">
                {dq ? 'Ничего не найдено' : 'За период упоминаний не найдено'}
              </li>
            )}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Entities />
    </Suspense>
  );
}
