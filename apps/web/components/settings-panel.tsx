'use client';
import { useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import {
  Badge,
  Button,
  Card,
  Icon,
  Input,
  Modal,
  Select,
  Skeleton,
  Switch,
  cn,
  useToast,
} from '@mediaradar/ui';
import { ErrorBox } from '@/components/page';
import { api, errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useMe } from '@/lib/me';

type Scope = 'platform' | 'tenant' | 'source' | 'user';
interface Item {
  key: string;
  title: string;
  description: string;
  ui: {
    kind: 'bool' | 'number' | 'enum' | 'text' | 'multi';
    options?: Array<{ value: string; label: string }>;
    unit?: string;
  };
  scopes: Scope[];
  editableScopes: Scope[];
  default: unknown;
  value: unknown;
  from: Scope | 'default';
  levels: Partial<Record<Scope, { value: unknown; version: number }>>;
  affectsBilling: boolean;
}
interface Settings {
  view: 'tenant' | 'platform';
  groups: Array<{ id: string; title: string; items: Item[] }>;
}
interface Hist {
  id: string;
  version: number;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  ts: string;
}

const FROM: Record<string, string> = {
  platform: 'платформа',
  tenant: 'тенант',
  user: 'личная',
  source: 'источник',
  default: 'по умолчанию',
};
const show = (v: unknown, item?: Item): string => {
  if (v === null || v === undefined) return 'не задано';
  if (typeof v === 'boolean') return v ? 'вкл.' : 'выкл.';
  if (Array.isArray(v))
    return v.map((x) => item?.ui.options?.find((o) => o.value === x)?.label ?? String(x)).join(', ');
  const opt = item?.ui.options?.find((o) => o.value === v);
  return opt ? opt.label : String(v);
};

function Row({
  item,
  view,
  reload,
}: {
  item: Item;
  view: 'tenant' | 'platform';
  reload: () => Promise<unknown>;
}) {
  const { me } = useMe();
  const toast = useToast();
  const scope: Scope | null =
    view === 'platform'
      ? item.editableScopes.includes('platform')
        ? 'platform'
        : null
      : item.editableScopes.includes('tenant')
        ? 'tenant'
        : item.editableScopes.includes('user')
          ? 'user'
          : null;
  const scopeId = scope === 'tenant' ? (me.tenant?.id ?? null) : scope === 'user' ? me.user.id : null;
  const setAtScope = scope ? item.levels[scope] : undefined;
  const [draft, setDraft] = useState<string>(String(item.value ?? ''));
  const [hist, setHist] = useState<Hist[] | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (value: unknown) => {
    if (!scope) return;
    setBusy(true);
    try {
      await api(`/v1/settings/${item.key}`, {
        method: 'PUT',
        body: { scope, scopeId, value, expectedVersion: setAtScope?.version ?? 0 },
      });
      toast(`«${item.title}» сохранено`, 'ok');
      await reload();
    } catch (e) {
      toast(errorMessage(e), 'err');
      await reload();
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    if (!scope) return;
    try {
      await api(`/v1/settings/${item.key}?scope=${scope}${scopeId ? `&scopeId=${scopeId}` : ''}`, {
        method: 'DELETE',
      });
      toast('Значение сброшено', 'ok');
      await reload();
    } catch (e) {
      toast(errorMessage(e), 'err');
    }
  };
  const openHistory = async () => {
    if (!scope) return;
    try {
      setHist(
        (
          await api<{ items: Hist[] }>(
            `/v1/settings/${item.key}/history?scope=${scope}${scopeId ? `&scopeId=${scopeId}` : ''}`,
          )
        ).items,
      );
    } catch (e) {
      toast(errorMessage(e), 'err');
    }
  };
  const rollback = async (id: string) => {
    try {
      await api(`/v1/settings/history/${id}/rollback`, { method: 'POST' });
      toast('Значение возвращено', 'ok');
      setHist(null);
      await reload();
    } catch (e) {
      toast(errorMessage(e), 'err');
    }
  };

  const disabled = !scope || busy;
  const control = (() => {
    switch (item.ui.kind) {
      case 'bool':
        return (
          <Switch
            checked={item.value === true}
            disabled={disabled}
            label={item.title}
            onChange={(v) => void save(v)}
          />
        );
      case 'enum':
        return (
          <Select
            aria-label={item.title}
            disabled={disabled}
            value={String(item.value ?? '')}
            onChange={(e) => void save(e.target.value)}
            className="!w-56 !py-1.5 !text-[12px]"
          >
            {item.ui.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        );
      case 'multi':
        return (
          <div className="flex flex-wrap gap-2">
            {item.ui.options?.map((o) => {
              const cur = (item.value as string[]) ?? [];
              const on = cur.includes(o.value);
              return (
                <label
                  key={o.value}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1 text-[12px]"
                >
                  <input
                    type="checkbox"
                    className="accent-[var(--accent)]"
                    disabled={disabled}
                    checked={on}
                    onChange={() => {
                      const next = on ? cur.filter((x) => x !== o.value) : [...cur, o.value];
                      if (next.length) void save(next);
                    }}
                  />
                  {o.label}
                </label>
              );
            })}
          </div>
        );
      case 'number':
        return (
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              aria-label={item.title}
              disabled={disabled}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => draft !== String(item.value ?? '') && draft !== '' && void save(Number(draft))}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              className="!w-28 !py-1.5 !text-[12px] font-mono"
            />
            {item.ui.unit && <span className="text-[12px] text-muted">{item.ui.unit}</span>}
          </div>
        );
      default:
        return (
          <Input
            aria-label={item.title}
            disabled={disabled}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => draft !== String(item.value ?? '') && draft.trim() && void save(draft)}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            className="!w-72 !py-1.5 !text-[12px]"
          />
        );
    }
  })();

  return (
    <li className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line py-3 last:border-0">
      <div className="min-w-[260px] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold">{item.title}</span>
          {item.affectsBilling && <Badge tone="warn">влияет на тариф</Badge>}
          {!scope && (
            <span title="Недостаточно прав для изменения">
              <Icon name="lock" size={13} className="text-faint" />
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[12px] leading-snug text-muted">{item.description}</p>
        <p className="mt-1 text-[11px] text-faint">
          Источник значения: <b className={cn(item.from !== 'default' && 'text-accent')}>{FROM[item.from]}</b>
          {item.from !== 'default' && <> · по умолчанию: {show(item.default, item)}</>}
        </p>
      </div>
      <div className="flex flex-none items-center gap-2">
        {control}
        {setAtScope && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void reset()}
            title="Сбросить к значению более широкой области или по умолчанию"
          >
            Сбросить
          </Button>
        )}
        {scope && (
          <button
            type="button"
            onClick={() => void openHistory()}
            aria-label={`История изменений: ${item.title}`}
            className="grid size-7 place-items-center rounded-lg text-faint hover:bg-surface-2 hover:text-fg"
          >
            <Icon name="history" size={15} />
          </button>
        )}
      </div>
      <Modal open={hist !== null} onClose={() => setHist(null)} title={`История: ${item.title}`} size="md">
        <ul className="divide-y divide-line">
          {hist?.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-3 py-2.5 text-[13px]">
              <span className="font-mono text-[11px] text-faint">
                v{h.version} · {dateTime(h.ts)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-muted">{show(h.oldValue, item)}</span> → <b>{show(h.newValue, item)}</b>
                {h.reason && <span className="ml-2 text-[12px] text-muted">({h.reason})</span>}
              </span>
              <Button size="sm" onClick={() => void rollback(h.id)}>
                Откатить
              </Button>
            </li>
          ))}
          {hist && !hist.length && <li className="py-6 text-center text-muted">Изменений пока нет</li>}
        </ul>
      </Modal>
    </li>
  );
}

/** Реестр настроек: значения по уровням (платформа → тенант → пользователь), права на изменение, история и откат. */
export function SettingsPanel({ view }: { view: 'tenant' | 'platform' }) {
  const { mutate: globalMutate } = useSWRConfig();
  const key = view === 'platform' ? '/v1/settings?scope=platform' : '/v1/settings';
  const { data, error, mutate } = useSWR<Settings>(key);
  const reload = async () => {
    await mutate();
    await globalMutate('/v1/auth/me');
  };
  if (error && !data) return <ErrorBox message={errorMessage(error)} onRetry={() => void mutate()} />;
  if (!data) return <Skeleton className="h-96" />;
  return (
    <div className="space-y-4">
      {data.groups.map((g) => (
        <Card key={g.id} className="p-5">
          <h2 id={`g-${g.id}`} className="mb-1 text-[15px] font-bold">
            {g.title}
          </h2>
          <ul aria-labelledby={`g-${g.id}`}>
            {g.items.map((i) => (
              <Row key={`${view}-${i.key}-${JSON.stringify(i.value)}`} item={i} view={view} reload={reload} />
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
