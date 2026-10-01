'use client';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import useSWRInfinite from 'swr/infinite';
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  Field,
  Icon,
  Input,
  Modal,
  Select,
  Skeleton,
  cn,
  useToast,
} from '@mediaradar/ui';
import { SENTIMENTS } from '@mediaradar/core/domain';
import { SentimentBadge, Thumb } from '@/components/charts-common';
import { ErrorBox, PageHeader } from '@/components/page';
import { api, errorMessage } from '@/lib/api';
import { dateTime, num, sentimentScore, timeAgo } from '@/lib/format';
import { useMe } from '@/lib/me';
import type { ArticleCard, ArticleDetail, ArticlePage, Facets } from '@/lib/types';

const SORTS = [
  ['date', 'Сначала новые'],
  ['old', 'Сначала старые'],
  ['sent', 'По тональности (негатив сверху)'],
  ['src', 'По источнику'],
] as const;
type Sort = (typeof SORTS)[number][0];
const LIST_KEYS = ['topics', 'kinds', 'sentiment', 'geo', 'sources'] as const;
type ListKey = (typeof LIST_KEYS)[number];

interface Filters {
  q: string;
  from: string;
  to: string;
  sort: Sort;
  topics: string[];
  kinds: string[];
  sentiment: string[];
  geo: string[];
  sources: string[];
}
const EMPTY: Filters = {
  q: '',
  from: '',
  to: '',
  sort: 'date',
  topics: [],
  kinds: [],
  sentiment: [],
  geo: [],
  sources: [],
};

function parse(sp: URLSearchParams): Filters {
  const sort = sp.get('sort');
  const list = (k: string) => (sp.get(k) ?? '').split(',').filter(Boolean);
  return {
    q: sp.get('q') ?? '',
    from: sp.get('from') ?? '',
    to: sp.get('to') ?? '',
    sort: SORTS.some((s) => s[0] === sort) ? (sort as Sort) : 'date',
    topics: list('topics'),
    kinds: list('kinds'),
    sentiment: list('sentiment'),
    geo: list('geo'),
    sources: list('sources'),
  };
}
function toParams(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.sort !== 'date') p.set('sort', f.sort);
  for (const k of LIST_KEYS) if (f[k].length) p.set(k, f[k].join(','));
  return p;
}
/** Параметры API: даты интерфейса (включительно) → границы запроса. */
function apiParams(f: Filters, withSort: boolean): URLSearchParams {
  const p = toParams(f);
  if (f.from) p.set('from', new Date(`${f.from}T00:00:00`).toISOString());
  if (f.to) p.set('to', new Date(new Date(`${f.to}T00:00:00`).getTime() + 864e5).toISOString());
  if (!withSort) p.delete('sort');
  return p;
}
const safeHref = (u: string) => (/^https?:\/\//i.test(u) ? u : '#');

function FeedCardView({ a, onOpen }: { a: ArticleCard; onOpen: () => void }) {
  const s = a.sentiment;
  const fresh = Date.now() - new Date(a.publishedAt).getTime() < 3600_000;
  return (
    <article className="group overflow-hidden rounded-card border border-line bg-surface shadow-card transition hover:-translate-y-0.5 hover:shadow-pop">
      <div className="relative">
        <Thumb color={a.topic?.color ?? '#64748b'} label={a.topic?.name ?? 'Материал'} />
        {s && <SentimentBadge label={s.label} className="absolute right-2.5 top-2.5 !bg-surface/95 shadow" />}
      </div>
      <div className="p-4">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted">
          {fresh && (
            <Badge tone="ok" title="Опубликовано за последний час">
              <span className="mr-pulse size-1.5 rounded-full bg-ok" />
              new
            </Badge>
          )}
          <span className="max-w-[150px] truncate font-bold text-accent">{a.source.domain}</span>
          <span aria-hidden>·</span>
          <span className="font-mono">{timeAgo(a.publishedAt)}</span>
          <span className="ml-auto flex items-center gap-1 font-mono">
            <Icon name="eye" size={12} />
            {num(a.views)}
          </span>
        </div>
        <h3 className="mb-2 line-clamp-3 text-[14px] font-bold leading-snug">
          <button type="button" onClick={onOpen} className="text-left transition group-hover:text-accent">
            {a.title}
          </button>
        </h3>
        {a.lead ? (
          <p className="mb-3 line-clamp-3 text-[12.5px] leading-relaxed text-muted">{a.lead}</p>
        ) : (
          <p className="mb-3 text-[12px] italic text-faint">
            Для этого источника показываются только заголовок и ссылка
          </p>
        )}
        <div className="mb-3 flex flex-wrap gap-1">
          {a.persons.map((p) => (
            <span
              key={p}
              className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent"
            >
              {p}
            </span>
          ))}
          {a.orgs.map((o) => (
            <span key={o} className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">
              {o}
            </span>
          ))}
          {a.geo && (
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-faint">
              {a.geo}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-line pt-3">
          <div
            className="relative h-1 flex-1 rounded-full bg-line"
            title={s ? `Тональность: ${sentimentScore(s.score)}` : undefined}
          >
            {s && (
              <div
                className="absolute h-full rounded-full"
                style={{
                  width: `${Math.abs(s.score) * 50}%`,
                  left: s.score < 0 ? `${50 - Math.abs(s.score) * 50}%` : '50%',
                  background: SENTIMENTS[s.label].hex,
                }}
              />
            )}
            <div className="absolute left-1/2 top-[-2px] h-2 w-px bg-line-strong" />
          </div>
          <button
            type="button"
            onClick={onOpen}
            className="text-[12px] font-bold text-accent hover:underline"
          >
            Открыть
          </button>
        </div>
      </div>
    </article>
  );
}

function ArticleModal({
  id,
  onClose,
  onOpenOther,
}: {
  id: string | null;
  onClose: () => void;
  onOpenOther: (id: string) => void;
}) {
  const { data, error } = useSWR<ArticleDetail>(id ? `/v1/articles/${id}` : null);
  const s = data?.sentiment;
  return (
    <Modal
      open={!!id}
      onClose={onClose}
      title={data?.title ?? 'Материал'}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Закрыть</Button>
          {data && (
            <a
              href={safeHref(data.url)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-ink-900 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-ink-800 dark:bg-accent dark:text-on-accent"
            >
              Открыть оригинал <Icon name="external" size={14} />
            </a>
          )}
        </>
      }
    >
      {error && <ErrorBox message={errorMessage(error)} />}
      {!data && !error && <Skeleton className="h-48" />}
      {data && (
        <div>
          <div className="mb-4 overflow-hidden rounded-xl">
            <Thumb color={data.topic?.color ?? '#64748b'} label={data.topic?.name ?? 'Материал'} />
          </div>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-[12px]">
            {s && (
              <Badge
                tone={
                  s.label === 'VN' ? 'bad' : s.label === 'NG' ? 'warn' : s.label === 'N' ? 'neutral' : 'ok'
                }
              >
                {SENTIMENTS[s.label].label} · {sentimentScore(s.score)}
              </Badge>
            )}
            {data.topic && <Badge>{data.topic.name}</Badge>}
            <span className="text-muted">
              {data.source.name} · {dateTime(data.publishedAt)}
            </span>
          </div>
          {data.policy === 'full' && data.body && (
            <div className="mb-4 space-y-3 text-[14px] leading-relaxed">
              {data.body.split(/\n+/).map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          )}
          {data.policy === 'excerpt' && (
            <div className="mb-4">
              <p className="text-[14px] leading-relaxed">{data.lead}</p>
              <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-muted">
                Политика контента для этого источника — «заголовок, лид и ссылка на оригинал». Полный текст
                доступен на сайте издания.
              </p>
            </div>
          )}
          {data.policy === 'metadata' && (
            <p className="mb-4 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-muted">
              Для этого источника показываются только заголовок и ссылка на оригинал.
            </p>
          )}
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            {(
              [
                ['Персоны', data.persons],
                ['Организации', data.orgs],
              ] as const
            ).map(([title, list]) => (
              <div key={title} className="rounded-xl border border-line bg-surface-2 p-3">
                <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">{title}</div>
                <div className="flex flex-wrap gap-1">
                  {list.length ? (
                    list.map((x) => (
                      <span
                        key={x}
                        className="rounded border border-line-strong bg-surface px-2 py-0.5 text-[12px] font-medium"
                      >
                        {x}
                      </span>
                    ))
                  ) : (
                    <span className="text-[12px] text-faint">не найдено</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          {data.related.length > 0 && (
            <div>
              <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">По теме</div>
              <ul className="space-y-1.5">
                {data.related.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => onOpenOther(r.id)}
                      className="w-full rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-surface-2"
                    >
                      <span className="line-clamp-1 font-medium">{r.title}</span>
                      <span className="text-[11px] text-muted">
                        {r.source.name} · {timeAgo(r.publishedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-4 break-all border-t border-line pt-3 font-mono text-[11px] text-faint">
            источник: {data.url}
          </div>
        </div>
      )}
    </Modal>
  );
}

interface SavedFilter {
  id: string;
  name: string;
  filter: Partial<Record<string, string | string[]>>;
  visibility: 'private' | 'team';
  mine: boolean;
  author: string | null;
}

function SaveFilterModal({
  open,
  onClose,
  filters,
  apply,
}: {
  open: boolean;
  onClose: () => void;
  filters: Filters;
  apply: (f: Filters) => void;
}) {
  const { can } = useMe();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const { data } = useSWR<{ items: SavedFilter[] }>(open ? '/v1/saved-filters' : null);
  const [name, setName] = useState('');
  const [team, setTeam] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const { sort: _sort, ...rest } = filters;
      const filter = Object.fromEntries(
        Object.entries(rest).filter(([, v]) => (Array.isArray(v) ? v.length : v)),
      );
      await api('/v1/saved-filters', {
        method: 'POST',
        body: { name, visibility: team ? 'team' : 'private', filter },
      });
      toast('Фильтр сохранён', 'ok');
      setName('');
      await mutate('/v1/saved-filters');
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    try {
      await api(`/v1/saved-filters/${id}`, { method: 'DELETE' });
      await mutate('/v1/saved-filters');
    } catch (e) {
      toast(errorMessage(e), 'err');
    }
  };
  const fromSaved = (s: SavedFilter): Filters => ({
    ...EMPTY,
    q: String(s.filter.q ?? ''),
    from: String(s.filter.from ?? ''),
    to: String(s.filter.to ?? ''),
    topics: [s.filter.topics ?? []].flat(),
    kinds: [s.filter.kinds ?? []].flat(),
    sentiment: [s.filter.sentiment ?? []].flat(),
    geo: [s.filter.geo ?? []].flat(),
    sources: [s.filter.sources ?? []].flat(),
  });
  const hasFilter =
    toParams(filters)
      .toString()
      .replace(/sort=\w+&?/, '').length > 0;
  return (
    <Modal open={open} onClose={onClose} title="Сохранённые фильтры" size="md">
      <div className="space-y-5">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field
            label="Сохранить текущий набор фильтров"
            hint={hasFilter ? undefined : 'Сначала задайте хотя бы один фильтр или поисковый запрос'}
          >
            {(id) => (
              <Input
                id={id}
                value={name}
                maxLength={120}
                placeholder="Например: негатив по топливу"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          {can('dashboard:build_team') && (
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={team}
                onChange={(e) => setTeam(e.target.checked)}
                className="accent-[var(--accent)]"
              />{' '}
              Сделать командным (виден всем в тенанте)
            </label>
          )}
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || !hasFilter}>
            Сохранить
          </Button>
        </form>
        <div>
          <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">
            Мои и командные
          </div>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {data?.items.map((s) => (
              <li key={s.id} className="flex items-center gap-2 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold">{s.name}</div>
                  <div className="text-[11px] text-muted">
                    {s.visibility === 'team' ? `Командный · ${s.author ?? ''}` : 'Личный'}
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    apply(fromSaved(s));
                    onClose();
                  }}
                >
                  Применить
                </Button>
                {s.mine && (
                  <button
                    type="button"
                    aria-label={`Удалить фильтр ${s.name}`}
                    onClick={() => void remove(s.id)}
                    className="grid size-8 place-items-center rounded-lg text-faint hover:bg-surface-2 hover:text-bad"
                  >
                    <Icon name="trash" />
                  </button>
                )}
              </li>
            ))}
            {data && !data.items.length && (
              <li className="px-3 py-5 text-center text-[13px] text-muted">Сохранённых фильтров пока нет</li>
            )}
          </ul>
        </div>
      </div>
    </Modal>
  );
}

function Feed() {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const filters = useMemo(() => parse(new URLSearchParams(sp.toString())), [sp]);
  const [search, setSearch] = useState(filters.q);
  const [openId, setOpenId] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const toast = useToast();

  const apply = useCallback(
    (f: Filters) =>
      router.replace(`${path}${toParams(f).toString() ? `?${toParams(f)}` : ''}`, { scroll: false }),
    [router, path],
  );
  useEffect(() => setSearch(filters.q), [filters.q]);
  useEffect(() => {
    if (search === filters.q) return;
    const t = setTimeout(() => apply({ ...filters, q: search }), 350);
    return () => clearTimeout(t);
  }, [search, filters, apply]);

  const base = apiParams(filters, true).toString();
  const { data: facets } = useSWR<Facets>(`/v1/articles/facets?${apiParams(filters, false)}`, {
    keepPreviousData: true,
  });
  const {
    data: pages,
    error,
    size,
    setSize,
    isValidating,
    mutate,
  } = useSWRInfinite<ArticlePage>(
    (index, prev) => {
      if (prev && !prev.nextCursor && prev.nextOffset === null) return null;
      const p = new URLSearchParams(base);
      p.set('limit', '12');
      if (prev?.nextCursor) p.set('cursor', prev.nextCursor);
      if (prev?.nextOffset != null) p.set('offset', String(prev.nextOffset));
      return `/v1/articles?${p}`;
    },
    { revalidateFirstPage: false, keepPreviousData: true },
  );

  const items = pages?.flatMap((p) => p.items) ?? [];
  const total = pages?.[0]?.total ?? 0;
  const last = pages?.[pages.length - 1];
  const hasMore = !!last && (!!last.nextCursor || last.nextOffset !== null);
  const loadingMore = isValidating && size > (pages?.length ?? 0);
  const toggle = (k: ListKey, v: string) =>
    apply({
      ...filters,
      [k]: filters[k].includes(v) ? filters[k].filter((x) => x !== v) : [...filters[k], v],
    });

  const rows: Array<{ k: ListKey; title: string; opts: Array<{ v: string; label: string; count: number }> }> =
    facets
      ? [
          {
            k: 'topics',
            title: 'Тема',
            opts: facets.topics.map((x) => ({ v: x.key, label: x.name, count: x.count })),
          },
          {
            k: 'kinds',
            title: 'Тип источника',
            opts: facets.kinds.map((x) => ({ v: x.key, label: x.label, count: x.count })),
          },
          {
            k: 'sentiment',
            title: 'Тональность',
            opts: facets.sentiment.map((x) => ({ v: x.key, label: x.label, count: x.count })),
          },
          {
            k: 'geo',
            title: 'География',
            opts: facets.geo.map((x) => ({ v: x.name, label: x.name, count: x.count })),
          },
          {
            k: 'sources',
            title: 'Источник',
            opts: facets.sources.slice(0, 14).map((x) => ({ v: x.id, label: x.domain, count: x.count })),
          },
        ]
      : [];
  const active = LIST_KEYS.flatMap((k) =>
    filters[k].map((v) => ({
      k,
      v,
      text:
        rows.find((r) => r.k === k)?.opts.find((o) => o.v === v)?.label ?? (k === 'sources' ? 'источник' : v),
    })),
  );

  return (
    <div className="mr-fade-up">
      <PageHeader
        eyebrow="Лента"
        title="Умные фильтры контента"
        actions={
          <>
            <Select
              aria-label="Сортировка"
              value={filters.sort}
              onChange={(e) => apply({ ...filters, sort: e.target.value as Sort })}
              className="!w-auto !py-2 text-[12px] font-semibold"
            >
              {SORTS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            <Button onClick={() => setSaveOpen(true)}>Сохранённые фильтры</Button>
          </>
        }
      />

      <Card className="mb-4 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[240px] flex-1">
            <Icon
              name="search"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
            />
            <Input
              aria-label="Поиск по материалам"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Полнотекстовый поиск · заголовки, лиды, персоны, организации…"
              className="!bg-surface-2 !pl-9"
            />
          </div>
          <div className="flex items-center gap-2 text-[12px]">
            <span className="font-semibold text-muted">Период</span>
            <Input
              type="date"
              aria-label="Начало периода"
              value={filters.from}
              max={filters.to || undefined}
              onChange={(e) => apply({ ...filters, from: e.target.value })}
              className="!w-auto !py-1.5 !text-[12px]"
            />
            <span className="text-faint">—</span>
            <Input
              type="date"
              aria-label="Конец периода"
              value={filters.to}
              min={filters.from || undefined}
              onChange={(e) => apply({ ...filters, to: e.target.value })}
              className="!w-auto !py-1.5 !text-[12px]"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              apply({ ...EMPTY, sort: filters.sort });
              toast('Фильтры сброшены');
            }}
          >
            Сбросить
          </Button>
        </div>
        <div className="space-y-2.5">
          {rows.map((r) => (
            <div key={r.k} className="flex items-start gap-3">
              <span className="w-[110px] flex-none pt-1.5 text-[11px] font-bold uppercase tracking-wider text-faint">
                {r.title}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {r.opts.map((o) => (
                  <Chip
                    key={o.v}
                    active={filters[r.k].includes(o.v)}
                    count={o.count}
                    onClick={() => toggle(r.k, o.v)}
                  >
                    {o.label}
                  </Chip>
                ))}
              </div>
            </div>
          ))}
          {!facets && <Skeleton className="h-24" />}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <div className="flex flex-wrap gap-1.5">
            {filters.q && (
              <button
                type="button"
                onClick={() => apply({ ...filters, q: '' })}
                className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[12px] font-medium text-on-accent"
              >
                «{filters.q}» <Icon name="x" size={12} />
              </button>
            )}
            {active.map((a) => (
              <button
                key={`${a.k}:${a.v}`}
                type="button"
                onClick={() => toggle(a.k, a.v)}
                aria-label={`Убрать фильтр: ${a.text}`}
                className="inline-flex items-center gap-1 rounded-md bg-ink-900 py-1 pl-2 pr-1.5 text-[12px] font-medium text-white dark:bg-accent dark:text-on-accent"
              >
                {a.text} <Icon name="x" size={12} />
              </button>
            ))}
            {!filters.q && !active.length && (
              <span className="text-[12px] text-faint">
                Фильтры не применены — показаны все доступные материалы
              </span>
            )}
          </div>
          <div className="whitespace-nowrap text-[12px] font-semibold text-muted" aria-live="polite">
            Найдено: {num(total)}
          </div>
        </div>
      </Card>

      {error && !items.length && <ErrorBox message={errorMessage(error)} onRetry={() => void mutate()} />}
      <div
        className={cn(
          'grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3',
          isValidating && !loadingMore && 'opacity-70 transition',
        )}
      >
        {items.map((a) => (
          <FeedCardView key={a.id} a={a} onOpen={() => setOpenId(a.id)} />
        ))}
        {!pages && Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-72" />)}
      </div>
      {pages && !items.length && (
        <Card>
          <EmptyState
            icon={<Icon name="search" size={36} />}
            title="Ничего не найдено"
            hint="Попробуйте изменить фильтры или поисковый запрос"
            action={<Button onClick={() => apply({ ...EMPTY })}>Сбросить фильтры</Button>}
          />
        </Card>
      )}
      {hasMore && (
        <div className="py-8 text-center">
          <Button loading={loadingMore} onClick={() => void setSize(size + 1)}>
            Показать ещё
          </Button>
        </div>
      )}

      <ArticleModal id={openId} onClose={() => setOpenId(null)} onOpenOther={setOpenId} />
      <SaveFilterModal open={saveOpen} onClose={() => setSaveOpen(false)} filters={filters} apply={apply} />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Feed />
    </Suspense>
  );
}
