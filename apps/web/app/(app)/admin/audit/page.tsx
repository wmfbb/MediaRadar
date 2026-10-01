'use client';
import { useState } from 'react';
import useSWRInfinite from 'swr/infinite';
import useSWR from 'swr';
import { Badge, Button, Card, Input, Select, Skeleton, Table, Td, Th } from '@mediaradar/ui';
import { ErrorBox, PageHeader } from '@/components/page';
import { errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { AUDIT_LABELS } from '@/lib/permissions';

interface Ev { id: string; ts: string; tenantId: string | null; tenantName: string | null; actorName: string | null; actorType: string; action: string; objectType: string | null; objectId: string | null; ip: string | null }
interface Page { items: Ev[]; nextBefore: string | null }

export default function Page() {
  const [tenant, setTenant] = useState('');
  const [action, setAction] = useState('');
  const tenants = useSWR<{ items: Array<{ id: string; name: string }> }>('/v1/admin/tenants');
  const { data, error, size, setSize, isValidating, mutate } = useSWRInfinite<Page>((i, prev) => {
    if (prev && !prev.nextBefore) return null;
    const p = new URLSearchParams({ limit: '50' });
    if (tenant) p.set('tenantId', tenant);
    if (action) p.set('action', action);
    if (prev?.nextBefore) p.set('before', prev.nextBefore);
    return `/v1/admin/audit?${p}`;
  });
  const items = data?.flatMap((p) => p.items) ?? [];
  const more = !!data?.[data.length - 1]?.nextBefore;
  return (
    <div className="mr-fade-up">
      <PageHeader eyebrow="Платформа" title="Журнал аудита" subtitle="Неизменяемый журнал: записи нельзя править или удалять" />
      <Card className="mb-4 flex flex-wrap items-center gap-3 p-4">
        <Select aria-label="Тенант" value={tenant} onChange={(e) => setTenant(e.target.value)} className="!w-56 !py-1.5 !text-[12px]"><option value="">Все тенанты</option>{tenants.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
        <Input aria-label="Префикс действия" value={action} onChange={(e) => setAction(e.target.value)} placeholder="Действие, например auth. или settings." className="!w-72 !py-1.5 !text-[12px] font-mono" />
      </Card>
      {error && <ErrorBox message={errorMessage(error)} onRetry={() => void mutate()} />}
      <Card className="overflow-hidden"><div className="overflow-x-auto"><Table>
        <thead><tr><Th>Время</Th><Th>Тенант</Th><Th>Кто</Th><Th>Действие</Th><Th>Объект</Th><Th>IP</Th></tr></thead>
        <tbody>
          {!data && <tr><td colSpan={6} className="p-4"><Skeleton className="h-28" /></td></tr>}
          {items.map((e) => <tr key={e.id} className="border-t border-line"><Td className="whitespace-nowrap font-mono text-[12px] text-muted">{dateTime(e.ts)}</Td><Td className="text-[12px]">{e.tenantName ?? <span className="text-faint">платформа</span>}</Td><Td className="text-[12px]">{e.actorName ?? <Badge>{e.actorType}</Badge>}</Td><Td><div className="text-[13px] font-semibold">{AUDIT_LABELS[e.action] ?? e.action}</div><div className="font-mono text-[11px] text-faint">{e.action}</div></Td><Td className="font-mono text-[11px] text-muted">{e.objectType ? `${e.objectType}${e.objectId ? `:${e.objectId.slice(0, 12)}` : ''}` : '—'}</Td><Td className="font-mono text-[11px] text-faint">{e.ip ?? '—'}</Td></tr>)}
          {data && !items.length && <tr><td colSpan={6} className="p-8 text-center text-muted">Записей нет</td></tr>}
        </tbody></Table></div></Card>
      {more && <div className="py-6 text-center"><Button loading={isValidating} onClick={() => void setSize(size + 1)}>Показать ещё</Button></div>}
    </div>
  );
}
