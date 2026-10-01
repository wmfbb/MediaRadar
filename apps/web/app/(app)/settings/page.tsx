'use client';
import { useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { Button, Card, Field, Input, useToast } from '@mediaradar/ui';
import { PageHeader } from '@/components/page';
import { SettingsPanel } from '@/components/settings-panel';
import { api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/me';

interface TenantInfo { slug: string; name: string; legalProfile: string; branding: { productName?: string; color?: string }; regionProfile: { core?: string; timezone?: string; region?: string } }

function TenantCard() {
  const { can } = useMe();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const { data } = useSWR<TenantInfo>('/v1/tenant');
  const [f, setF] = useState<{ name: string; productName: string } | null>(null);
  if (!data) return null;
  const cur = f ?? { name: data.name, productName: data.branding.productName ?? '' };
  const save = async () => {
    try {
      await api('/v1/tenant', { method: 'PATCH', body: { name: cur.name, branding: cur.productName ? { productName: cur.productName } : undefined } });
      toast('Данные тенанта сохранены', 'ok');
      setF(null);
      await Promise.all([mutate('/v1/tenant'), mutate('/v1/auth/me')]);
    } catch (e) { toast(errorMessage(e), 'err'); }
  };
  return (
    <Card className="mb-4 p-5">
      <h2 className="mb-4 text-[15px] font-bold">Тенант</h2>
      <dl className="mb-4 grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2 xl:grid-cols-4">
        {[['Идентификатор (slug)', data.slug], ['Регион', data.regionProfile.region ?? '—'], ['Ядро', data.regionProfile.core ?? '—'], ['Часовой пояс', data.regionProfile.timezone ?? '—'], ['Юридический профиль', data.legalProfile]].map(([k, v]) => <div key={k}><dt className="text-[11px] font-bold uppercase tracking-wider text-muted">{k}</dt><dd className="mt-0.5 font-mono text-[12.5px]">{v}</dd></div>)}
      </dl>
      {can('tenant:settings_basic') && (
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <div className="w-64"><Field label="Название">{(id) => <Input id={id} value={cur.name} maxLength={120} onChange={(e) => setF({ ...cur, name: e.target.value })} />}</Field></div>
          <div className="w-64"><Field label="Название продукта (бренд региона)">{(id) => <Input id={id} value={cur.productName} maxLength={60} placeholder="Например, Алтай.Медиа" onChange={(e) => setF({ ...cur, productName: e.target.value })} />}</Field></div>
          <Button type="submit" variant="primary" disabled={!f}>Сохранить</Button>
        </form>
      )}
    </Card>
  );
}

export default function Page() {
  return (
    <div className="mr-fade-up">
      <PageHeader eyebrow="Конфигурация" title="Настройки" subtitle="Каждое значение берётся с самого специфичного уровня: пользователь → тенант → платформа → по умолчанию. Изменения фиксируются в журнале аудита и откатываются." />
      <TenantCard />
      <SettingsPanel view="tenant" />
    </div>
  );
}
