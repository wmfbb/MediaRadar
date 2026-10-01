'use client';
import useSWR, { useSWRConfig } from 'swr';
import { Badge, Card, Select, Skeleton, Table, Td, Th, useToast } from '@mediaradar/ui';
import { ErrorBox, PageHeader } from '@/components/page';
import { api, errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useMe } from '@/lib/me';

interface T {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended' | 'archived';
  createdAt: string;
  planKey: string | null;
  planStatus: string | null;
  members: number;
  sources: number;
}
const TONE = { active: 'ok', suspended: 'warn', archived: 'neutral' } as const;
const LABEL = { active: 'активен', suspended: 'приостановлен', archived: 'в архиве' } as const;

export default function Page() {
  const { can } = useMe();
  const toast = useToast();
  const { mutate: gm } = useSWRConfig();
  const { data, error, mutate } = useSWR<{ items: T[] }>('/v1/admin/tenants');
  const setStatus = async (t: T, status: string) => {
    if (
      status !== 'active' &&
      !window.confirm(
        `Изменить статус тенанта «${t.name}» на «${LABEL[status as keyof typeof LABEL]}»? Его пользователи потеряют доступ.`,
      )
    )
      return;
    try {
      await api(`/v1/admin/tenants/${t.id}`, { method: 'PATCH', body: { status } });
      toast('Статус тенанта изменён', 'ok');
      await Promise.all([mutate(), gm('/v1/auth/me')]);
    } catch (e) {
      toast(errorMessage(e), 'err');
    }
  };
  return (
    <div className="mr-fade-up">
      <PageHeader eyebrow="Платформа" title="Тенанты" subtitle="Клиенты и регионы платформы" />
      {error && <ErrorBox message={errorMessage(error)} onRetry={() => void mutate()} />}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Тенант</Th>
                <Th>Тариф</Th>
                <Th align="right">Участников</Th>
                <Th align="right">Источников</Th>
                <Th>Создан</Th>
                <Th>Статус</Th>
              </tr>
            </thead>
            <tbody>
              {!data && (
                <tr>
                  <td colSpan={6} className="p-4">
                    <Skeleton className="h-20" />
                  </td>
                </tr>
              )}
              {data?.items.map((t) => (
                <tr key={t.id} className="border-t border-line">
                  <Td>
                    <div className="font-semibold">{t.name}</div>
                    <div className="font-mono text-[11px] text-faint">{t.slug}</div>
                  </Td>
                  <Td>{t.planKey ? <Badge tone="accent">{t.planKey.toUpperCase()}</Badge> : '—'}</Td>
                  <Td className="text-right font-mono">{t.members}</Td>
                  <Td className="text-right font-mono">{t.sources}</Td>
                  <Td className="font-mono text-[12px] text-muted">{dateTime(t.createdAt)}</Td>
                  <Td>
                    {can('platform:settings') ? (
                      <Select
                        aria-label={`Статус: ${t.name}`}
                        value={t.status}
                        onChange={(e) => void setStatus(t, e.target.value)}
                        className="!w-44 !py-1 !text-[12px] font-semibold"
                      >
                        <option value="active">активен</option>
                        <option value="suspended">приостановлен</option>
                        <option value="archived">в архиве</option>
                      </Select>
                    ) : (
                      <Badge tone={TONE[t.status]}>{LABEL[t.status]}</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
