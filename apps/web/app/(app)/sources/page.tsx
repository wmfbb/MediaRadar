'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { SOURCE_KINDS, PARSERS } from '@mediaradar/core/domain';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Input,
  Modal,
  Select,
  Skeleton,
  Table,
  Tabs,
  Td,
  Textarea,
  Th,
  cn,
  useToast,
} from '@mediaradar/ui';
import { ErrorBox, PageHeader } from '@/components/page';
import { api, errorMessage, fieldError } from '@/lib/api';
import { cronLabel, dateTime, num, timeAgo } from '@/lib/format';
import { useMe } from '@/lib/me';

interface Source {
  id: string;
  name: string;
  url: string;
  domain: string;
  kind: keyof typeof SOURCE_KINDS;
  parser: string;
  cron: string;
  status: 'active' | 'paused' | 'error' | 'needs_attention';
  trust: number;
  itemsCount: number;
  lastRunAt: string | null;
  lastError: string | null;
  errorCount: number;
  city: string | null;
  isPrivate: boolean;
  demo: boolean;
  enabled: boolean;
  topic: { key: string; name: string; color: string } | null;
}
interface SourceList {
  items: Source[];
  kpis: { total: number; active: number; errors: number; collected: number };
}
interface SourceDetail extends Source {
  config: Record<string, unknown> | null;
  versions: Array<{ id: string; version: number; note: string | null; isActive: boolean; createdAt: string }>;
}

const STATUS = {
  active: ['ok', 'online'],
  error: ['bad', 'ошибка'],
  needs_attention: ['warn', 'нужно внимание'],
  paused: ['neutral', 'пауза'],
} as const;
type Tab = 'all' | 'active' | 'error' | 'paused';

function ConfigModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can } = useMe();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const { data, error } = useSWR<SourceDetail>(id ? `/v1/sources/${id}` : null);
  const [text, setText] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const json = text ?? JSON.stringify(data?.config ?? {}, null, 2);
  const editable = !!data?.isPrivate && can('source:manage_private');
  let parsedOk = true;
  try {
    JSON.parse(json);
  } catch {
    parsedOk = false;
  }
  const close = () => {
    setText(null);
    setNote('');
    onClose();
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ version: number }>(`/v1/sources/${id}/config`, {
        method: 'PUT',
        body: { config: JSON.parse(json), note: note || undefined },
      });
      toast(`Конфигурация сохранена (версия ${r.version})`, 'ok');
      await mutate(`/v1/sources/${id}`);
      setText(null);
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!id}
      onClose={close}
      title={data ? `Конфигурация парсера · ${data.domain}` : 'Конфигурация парсера'}
      size="lg"
      footer={
        <>
          <Button onClick={close}>Закрыть</Button>
          {editable && (
            <Button variant="primary" onClick={save} loading={busy} disabled={!parsedOk || text === null}>
              Сохранить новую версию
            </Button>
          )}
        </>
      }
    >
      {error && <ErrorBox message={errorMessage(error)} />}
      {!data && !error && <Skeleton className="h-64" />}
      {data && (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-3">
            {[
              ['Название', data.name],
              ['Тип', SOURCE_KINDS[data.kind]],
              ['Парсер', data.parser],
              ['Расписание', data.cron],
              ['Территория', data.city ?? '—'],
              ['Доверие', `${data.trust}%`],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-[11px] font-bold uppercase tracking-wider text-muted">{k}</dt>
                <dd className="mt-0.5 font-medium">{v}</dd>
              </div>
            ))}
          </dl>
          {!editable && (
            <p className="rounded-lg bg-info-soft px-3 py-2 text-[12.5px] text-info">
              {data.isPrivate
                ? 'У вас нет права менять конфигурации источников.'
                : 'Это источник общего каталога платформы: его конфигурацию меняет администратор платформы (редактор парсеров — Фаза 1).'}
            </p>
          )}
          <div>
            <label
              htmlFor="cfg"
              className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-muted"
            >
              Инструкция парсинга (JSON) · версия {data.versions.find((v) => v.isActive)?.version ?? '—'}
            </label>
            <Textarea
              id="cfg"
              rows={13}
              readOnly={!editable}
              spellCheck={false}
              value={json}
              onChange={(e) => setText(e.target.value)}
              className="!bg-surface-2 font-mono !text-[12px] leading-relaxed"
              aria-invalid={!parsedOk}
            />
            {!parsedOk && (
              <p role="alert" className="mt-1 text-[12px] text-bad">
                Некорректный JSON
              </p>
            )}
          </div>
          {editable && (
            <Field label="Комментарий к версии">
              {(fid) => (
                <Input id={fid} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
              )}
            </Field>
          )}
          <div>
            <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted">
              История версий
            </div>
            <ul className="divide-y divide-line rounded-xl border border-line text-[13px]">
              {data.versions.map((v) => (
                <li key={v.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="font-mono font-bold">v{v.version}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{v.note ?? '—'}</span>
                  <span className="font-mono text-[11px] text-faint">{dateTime(v.createdAt)}</span>
                  {v.isActive && <Badge tone="ok">активна</Badge>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  );
}

function AddSourceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const [f, setF] = useState({
    name: '',
    url: '',
    kind: 'NEWS_SITE',
    parser: 'RSS',
    cron: '*/15 * * * *',
    city: '',
  });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api('/v1/sources', { method: 'POST', body: { ...f, city: f.city || undefined } });
      toast('Источник добавлен. Сбор данных начнётся после реализации Фазы 1.', 'ok');
      await mutate('/v1/sources');
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.value });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Добавить источник"
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!f.name || !f.url}>
            Добавить
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {!!err && !fieldError(err, 'url') && (
          <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad sm:col-span-2">
            {errorMessage(err)}
          </p>
        )}
        <div className="sm:col-span-2">
          <Field label="Название" error={fieldError(err, 'name')}>
            {(id) => (
              <Input id={id} value={f.name} onChange={set('name')} placeholder="Например, «Вестник района»" />
            )}
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field
            label="Адрес ресурса"
            error={fieldError(err, 'url')}
            hint="Только публичные http/https-адреса; адреса внутренней сети отклоняются"
          >
            {(id) => (
              <Input
                id={id}
                value={f.url}
                onChange={set('url')}
                placeholder="https://example22.ru"
                className="font-mono"
              />
            )}
          </Field>
        </div>
        <Field label="Тип">
          {(id) => (
            <Select id={id} value={f.kind} onChange={set('kind')}>
              {Object.entries(SOURCE_KINDS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Парсер">
          {(id) => (
            <Select id={id} value={f.parser} onChange={set('parser')}>
              {PARSERS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Расписание (cron)" error={fieldError(err, 'cron')}>
          {(id) => <Input id={id} value={f.cron} onChange={set('cron')} className="font-mono" />}
        </Field>
        <Field label="Территория">
          {(id) => <Input id={id} value={f.city} onChange={set('city')} placeholder="Барнаул" />}
        </Field>
        <div className="rounded-xl border border-accent/20 bg-accent-soft p-3 text-[12.5px] sm:col-span-2">
          <b className="text-accent">Автоопределение селекторов</b>
          <p className="mt-1 text-muted">
            В Фазе 1 система загрузит страницу, предложит селекторы списка, заголовка, даты и текста и покажет
            предпросмотр извлечения. Сейчас создаётся стартовая конфигурация, её можно отредактировать
            вручную.
          </p>
        </div>
      </div>
    </Modal>
  );
}

export default function Page() {
  const { can } = useMe();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const { data, error, mutate: reload } = useSWR<SourceList>('/v1/sources');
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [cfgId, setCfgId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [discover, setDiscover] = useState(false);
  const manage = can('source:manage_private');

  const items = useMemo(
    () =>
      (data?.items ?? []).filter(
        (s) =>
          (tab === 'all' ||
            (tab === 'error' ? s.status === 'error' || s.status === 'needs_attention' : s.status === tab)) &&
          (!q || `${s.name} ${s.domain}`.toLowerCase().includes(q.toLowerCase())),
      ),
    [data, tab, q],
  );
  const counts = (t: Tab) =>
    (data?.items ?? []).filter(
      (s) =>
        t === 'all' ||
        (t === 'error' ? s.status === 'error' || s.status === 'needs_attention' : s.status === t),
    ).length;

  const run = async (s: Source) => {
    try {
      const r = await api<{ queued: boolean; implemented: boolean }>(`/v1/sources/${s.id}/run`, {
        method: 'POST',
      });
      toast(
        r.queued
          ? `Источник ${s.domain} поставлен в очередь — новые материалы появятся в ленте через несколько секунд`
          : 'Очередь недоступна: Redis не подключён',
        r.queued ? 'info' : 'warn',
      );
    } catch (e) {
      toast(errorMessage(e), 'err');
    }
  };
  const toggle = async (s: Source) => {
    try {
      await api(`/v1/sources/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } });
      toast(`Источник «${s.name}» ${s.enabled ? 'поставлен на паузу' : 'возобновлён'}`, 'ok');
      await Promise.all([reload(), mutate('/v1/dashboard')]);
    } catch (e) {
      toast(errorMessage(e), 'err');
    }
  };

  const kpis = data
    ? [
        ['Всего источников', data.kpis.total, 'реестр тенанта'],
        ['Активно', data.kpis.active, 'опрос по расписанию'],
        ['С ошибками', data.kpis.errors, 'требуют вмешательства'],
        ['Собрано материалов', num(data.kpis.collected), 'за всё время'],
      ]
    : [];

  return (
    <div className="mr-fade-up">
      <PageHeader
        eyebrow="Источники"
        title="Реестр ресурсов и парсеры"
        subtitle="Ручное добавление с инструкциями парсинга и AI-дискавери новых ресурсов"
        actions={
          <>
            <Button onClick={() => setDiscover(true)}>
              <Icon name="search" size={14} /> AI-дискавери источников
            </Button>
            {manage && (
              <Button variant="primary" onClick={() => setAdding(true)}>
                <Icon name="plus" size={14} /> Добавить источник
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-4 xl:grid-cols-4">
        {kpis.map(([l, v, h]) => (
          <Card key={String(l)} className="p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{l}</div>
            <div className="mt-1 font-mono text-[24px] font-extrabold tracking-tight">{v}</div>
            <div className="mt-0.5 text-[12px] text-faint">{h}</div>
          </Card>
        ))}
        {!data && !error && Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24" />)}
      </div>
      {error && !data && <ErrorBox message={errorMessage(error)} onRetry={() => void reload()} />}
      {data && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
            <Tabs
              value={tab}
              onChange={setTab}
              options={[
                { value: 'all', label: 'Все', count: counts('all') },
                { value: 'active', label: 'Активные', count: counts('active') },
                { value: 'error', label: 'С ошибками', count: counts('error') },
                { value: 'paused', label: 'Пауза', count: counts('paused') },
              ]}
            />
            <Input
              aria-label="Фильтр по названию или домену"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Фильтр по названию или домену…"
              className="ml-auto !w-64 !bg-surface-2 !py-1.5 !text-[12px]"
            />
          </div>
          <div className="overflow-x-auto">
            <Table className="min-w-[960px]">
              <thead>
                <tr>
                  <Th>Источник</Th>
                  <Th>Тип · парсер</Th>
                  <Th>Расписание</Th>
                  <Th align="right">Материалов</Th>
                  <Th>Последний запуск</Th>
                  <Th>Статус</Th>
                  <Th align="right">Действия</Th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => {
                  const [tone, text] = STATUS[s.status];
                  return (
                    <tr key={s.id} className="border-t border-line transition hover:bg-surface-2">
                      <Td>
                        <div className="flex items-center gap-2.5">
                          <span
                            className="grid size-7 flex-none place-items-center rounded-lg text-[10px] font-extrabold text-white"
                            style={{ background: s.topic?.color ?? '#64748b' }}
                          >
                            {s.domain.slice(0, 2).toUpperCase()}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <Link
                                href={`/sources/${s.id}`}
                                className="max-w-[230px] truncate font-semibold hover:text-accent hover:underline"
                              >
                                {s.name}
                              </Link>
                              {s.isPrivate && (
                                <Badge tone="accent" title="Приватный источник тенанта">
                                  приватный
                                </Badge>
                              )}
                            </div>
                            <div className="max-w-[240px] truncate font-mono text-[11px] text-faint">
                              {s.domain}
                            </div>
                          </div>
                        </div>
                      </Td>
                      <Td>
                        <div className="text-[12.5px] text-muted">{SOURCE_KINDS[s.kind]}</div>
                        <code className="font-mono text-[10.5px] text-faint">{s.parser}</code>
                      </Td>
                      <Td className="whitespace-nowrap text-[12px] text-muted">
                        <span title={s.cron}>{cronLabel(s.cron)}</span>
                      </Td>
                      <Td className="text-right font-mono font-semibold">{num(s.itemsCount)}</Td>
                      <Td className="whitespace-nowrap text-[12px] text-muted">
                        {s.lastRunAt ? timeAgo(s.lastRunAt) : '—'}
                      </Td>
                      <Td>
                        <Badge tone={tone} title={s.lastError ?? undefined}>
                          <span
                            className={cn(
                              'size-1.5 rounded-full bg-current',
                              s.status === 'active' && 'mr-pulse',
                            )}
                          />
                          {text}
                          {s.errorCount > 0 && <span className="font-mono opacity-70">×{s.errorCount}</span>}
                        </Badge>
                      </Td>
                      <Td className="whitespace-nowrap text-right">
                        {manage && (
                          <Button
                            size="sm"
                            className="mr-1"
                            onClick={() => void run(s)}
                            disabled={!s.enabled}
                          >
                            Парсить
                          </Button>
                        )}
                        <Button size="sm" className="mr-1" onClick={() => setCfgId(s.id)}>
                          Конфиг
                        </Button>
                        {manage && (
                          <Button size="sm" onClick={() => void toggle(s)}>
                            {s.enabled ? 'Пауза' : 'Включить'}
                          </Button>
                        )}
                      </Td>
                    </tr>
                  );
                })}
                {!items.length && (
                  <tr>
                    <td colSpan={7}>
                      <EmptyState title="Источники не найдены" hint="Измените фильтр или вкладку" />
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </div>
        </Card>
      )}
      <ConfigModal id={cfgId} onClose={() => setCfgId(null)} />
      <AddSourceModal open={adding} onClose={() => setAdding(false)} />
      <Modal
        open={discover}
        onClose={() => setDiscover(false)}
        title="AI-дискавери источников · Фаза 6"
        footer={
          <Button variant="primary" onClick={() => setDiscover(false)}>
            Понятно
          </Button>
        }
      >
        <div className="space-y-3 text-[13px] leading-relaxed">
          <p>Эта функция реализуется в Фазе 6. Планируемый процесс:</p>
          <ol className="list-decimal space-y-1.5 pl-5 text-muted">
            <li>
              Вы задаёте территорию, отрасли и уровни детализации (ядро → города → районы → населённые
              пункты).
            </li>
            <li>
              Система формирует поисковые запросы, обходит открытые каталоги и ссылки известных источников.
            </li>
            <li>
              Для каждого кандидата проверяет «жив ли сайт» и «извлекаются ли заголовок, дата и текст»,
              считает рейтинг авторитетности.
            </li>
            <li>
              Кандидаты попадают в очередь на утверждение вам; одобренные подключаются с автоматической
              конфигурацией и ретро-сбором.
            </li>
          </ol>
          <p className="text-muted">
            Языковая модель не ходит в интернет сама: поиск и обход выполняет код, модель классифицирует
            найденное.
          </p>
        </div>
      </Modal>
    </div>
  );
}
