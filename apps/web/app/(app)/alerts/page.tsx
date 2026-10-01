'use client';
import { useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { ALERT_LEVELS } from '@mediaradar/core/domain';
import { Badge, Button, Card, EmptyState, Field, Icon, Input, Modal, Select, Skeleton, Switch, cn, useToast } from '@mediaradar/ui';
import { ErrorBox, PageHeader } from '@/components/page';
import { api, ApiError, errorMessage, fieldError } from '@/lib/api';
import { useMe } from '@/lib/me';

interface Rule { id: string; name: string; level: 'high' | 'mid' | 'low'; keywords: string[]; scope: string[]; channels: string[]; enabled: boolean; firedCount: number; createdBy: string | null }
const LEVEL = { high: ['bad', 'Критический'], mid: ['warn', 'Важный'], low: ['neutral', 'Информационный'] } as const;
const CHANNELS = ['Telegram', 'Email', 'SMS', 'PDF-дайджест'] as const;

function RuleModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const [f, setF] = useState({ name: '', level: 'mid' as Rule['level'], channels: ['Telegram'] as string[], scope: 'Все источники' });
  const [kw, setKw] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const addKw = () => { const v = draft.trim(); if (v.length >= 2 && !kw.includes(v)) setKw([...kw, v]); setDraft(''); };
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api('/v1/alerts', { method: 'POST', body: { name: f.name, level: f.level, keywords: draft.trim().length >= 2 ? [...kw, draft.trim()] : kw, channels: f.channels, scope: f.scope.split(',').map((s) => s.trim()).filter(Boolean) } });
      toast('Правило создано', 'ok');
      await mutate('/v1/alerts');
      setF({ name: '', level: 'mid', channels: ['Telegram'], scope: 'Все источники' });
      setKw([]);
      setDraft('');
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Новое правило алерта" footer={<><Button onClick={onClose}>Отмена</Button><Button variant="primary" loading={busy} onClick={submit} disabled={!f.name}>Создать</Button></>}>
      <div className="space-y-4">
        {!!err && !fieldError(err, 'name') && <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad">{errorMessage(err)}</p>}
        <Field label="Название" error={fieldError(err, 'name')}>{(id) => <Input id={id} value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Например, негатив по топливному сектору" />}</Field>
        <Field label="Ключевые слова" hint="Введите слово и нажмите Enter" error={err instanceof ApiError ? (err.errors?.find((x) => x.path.startsWith('keywords'))?.message ?? null) : null}>
          {(id) => (
            <div>
              <Input id={id} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKw(); } }} onBlur={addKw} placeholder="дизтопливо" />
              <div className="mt-2 flex flex-wrap gap-1.5">{kw.map((k) => <span key={k} className="inline-flex items-center gap-1 rounded bg-accent-soft px-2 py-1 font-mono text-[12px] text-accent">{k}<button type="button" aria-label={`Убрать «${k}»`} onClick={() => setKw(kw.filter((x) => x !== k))}><Icon name="x" size={12} /></button></span>)}</div>
            </div>
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Важность">{(id) => <Select id={id} value={f.level} onChange={(e) => setF({ ...f, level: e.target.value as Rule['level'] })}>{ALERT_LEVELS.map((l) => <option key={l} value={l}>{LEVEL[l][1]}</option>)}</Select>}</Field>
          <Field label="Область" hint="Через запятую">{(id) => <Input id={id} value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} />}</Field>
        </div>
        <fieldset><legend className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted">Каналы доставки</legend>
          <div className="flex flex-wrap gap-2">{CHANNELS.map((c) => <label key={c} className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line-strong px-3 py-1.5 text-[12.5px] font-medium hover:bg-surface-2"><input type="checkbox" className="accent-[var(--accent)]" checked={f.channels.includes(c)} onChange={() => setF({ ...f, channels: f.channels.includes(c) ? f.channels.filter((x) => x !== c) : [...f.channels, c] })} />{c}</label>)}</div>
          <p className="mt-2 text-[12px] text-muted">Правила сохраняются сейчас; рассылка уведомлений подключается в Фазе 5.</p>
        </fieldset>
      </div>
    </Modal>
  );
}

export default function Page() {
  const { can, me } = useMe();
  const toast = useToast();
  const { data, error, mutate } = useSWR<{ items: Rule[] }>('/v1/alerts');
  const [open, setOpen] = useState(false);
  const canEdit = (r: Rule) => r.createdBy === me.user.id || can('alert:manage_team');
  const toggle = async (r: Rule) => {
    try { await api(`/v1/alerts/${r.id}`, { method: 'PATCH', body: { enabled: !r.enabled } }); toast(`Правило «${r.name}» ${r.enabled ? 'выключено' : 'включено'}`, r.enabled ? 'warn' : 'ok'); await mutate(); } catch (e) { toast(errorMessage(e), 'err'); }
  };
  const remove = async (r: Rule) => {
    if (!window.confirm(`Удалить правило «${r.name}»?`)) return;
    try { await api(`/v1/alerts/${r.id}`, { method: 'DELETE' }); toast('Правило удалено', 'ok'); await mutate(); } catch (e) { toast(errorMessage(e), 'err'); }
  };
  return (
    <div className="mr-fade-up">
      <PageHeader eyebrow="Мониторинг" title="Правила и алерты" actions={<Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" size={14} /> Новое правило</Button>} />
      {error && !data && <ErrorBox message={errorMessage(error)} onRetry={() => void mutate()} />}
      {!data && !error && <div className="grid gap-4 xl:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-48" />)}</div>}
      {data && !data.items.length && <Card><EmptyState icon={<Icon name="bell" size={36} />} title="Правил пока нет" hint="Создайте правило, и система будет следить за ключевыми словами в новых материалах" action={<Button variant="primary" onClick={() => setOpen(true)}>Создать правило</Button>} /></Card>}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {data?.items.map((r) => (
          <Card key={r.id} className={cn('p-5', !r.enabled && 'opacity-60')}>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div><h3 className="text-[14px] font-bold leading-snug">{r.name}</h3><Badge tone={LEVEL[r.level][0]} className="mt-1.5">{LEVEL[r.level][1]}</Badge></div>
              <Switch checked={r.enabled} onChange={() => void toggle(r)} label={`Правило «${r.name}»`} disabled={!canEdit(r)} />
            </div>
            <div className="mb-3"><div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-faint">Ключевые слова</div><div className="flex flex-wrap gap-1">{r.keywords.map((k) => <span key={k} className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[11px] font-medium text-accent">{k}</span>)}</div></div>
            <div className="mb-3"><div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-faint">Область</div><div className="text-[12.5px] text-muted">{r.scope.join(' · ')}</div></div>
            <div className="flex items-center justify-between border-t border-line pt-3">
              <div className="flex flex-wrap gap-1">{r.channels.map((c) => <Badge key={c}>{c}</Badge>)}</div>
              <div className="flex items-center gap-2"><span className="font-mono text-[11px] text-faint">сработал {r.firedCount}×</span>{canEdit(r) && <button type="button" aria-label={`Удалить правило «${r.name}»`} onClick={() => void remove(r)} className="grid size-7 place-items-center rounded-lg text-faint hover:bg-surface-2 hover:text-bad"><Icon name="trash" size={14} /></button>}</div>
            </div>
          </Card>
        ))}
      </div>
      <RuleModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
