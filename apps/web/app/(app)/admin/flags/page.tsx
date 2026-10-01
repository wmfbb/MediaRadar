'use client';
import useSWR from 'swr';
import { Card, Skeleton, Switch, useToast } from '@mediaradar/ui';
import { ErrorBox, PageHeader } from '@/components/page';
import { api, errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';

export default function Page() {
  const toast = useToast();
  const { data, error, mutate } = useSWR<{ items: Array<{ key: string; enabled: boolean; description: string | null; updatedAt: string }> }>('/v1/admin/flags');
  const toggle = async (key: string, enabled: boolean) => {
    try { await api(`/v1/admin/flags/${key}`, { method: 'PUT', body: { enabled } }); toast(`Флаг «${key}» ${enabled ? 'включён' : 'выключен'}`, 'ok'); await mutate(); } catch (e) { toast(errorMessage(e), 'err'); }
  };
  return (
    <div className="mr-fade-up">
      <PageHeader eyebrow="Платформа" title="Флаги функций" subtitle="Включение крупных возможностей без выпуска новой версии" />
      {error && <ErrorBox message={errorMessage(error)} onRetry={() => void mutate()} />}
      <Card className="divide-y divide-line">
        {!data && <div className="p-5"><Skeleton className="h-24" /></div>}
        {data?.items.map((f) => (
          <div key={f.key} className="flex items-center gap-4 px-5 py-4"><div className="min-w-0 flex-1"><div className="font-mono text-[13px] font-semibold">{f.key}</div><div className="text-[12px] text-muted">{f.description}</div></div><span className="font-mono text-[11px] text-faint">{dateTime(f.updatedAt)}</span><Switch checked={f.enabled} onChange={(v) => void toggle(f.key, v)} label={f.key} /></div>
        ))}
      </Card>
    </div>
  );
}
