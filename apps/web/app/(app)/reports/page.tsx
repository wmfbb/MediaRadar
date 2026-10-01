'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Skeleton,
  Table,
  Td,
  Th,
  useToast,
} from '@mediaradar/ui';
import { DemoNote, ErrorBox, PageHeader } from '@/components/page';
import { api, errorMessage } from '@/lib/api';
import { sizeLabel } from '@/lib/format';
import { useMe } from '@/lib/me';

interface Template {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
}
interface Run {
  id: string;
  name: string;
  type: string;
  periodFrom: string;
  periodTo: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  format: string | null;
  sizeBytes: number | null;
  error: string | null;
  createdAt: string;
}
const STATUS = {
  queued: ['info', 'В очереди'],
  running: ['accent', 'Формируется'],
  completed: ['ok', 'Готов'],
  failed: ['bad', 'Ошибка'],
} as const;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export default function Page() {
  const { can } = useMe();
  const router = useRouter();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const tpl = useSWR<{ items: Template[] }>('/v1/reports/templates');
  const runs = useSWR<{ items: Run[] }>('/v1/reports/runs');
  const [pick, setPick] = useState<{ t: Template; format: 'pdf' | 'xlsx' } | null>(null);
  const [period, setPeriod] = useState({ from: iso(new Date(Date.now() - 30 * 864e5)), to: iso(new Date()) });
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!pick) return;
    setBusy(true);
    try {
      await api('/v1/reports/runs', {
        method: 'POST',
        body: {
          templateKey: pick.t.key,
          format: pick.format,
          from: new Date(`${period.from}T00:00:00`).toISOString(),
          to: new Date(`${period.to}T23:59:59`).toISOString(),
        },
      });
      toast('Запрос сохранён в очереди. Генерация файлов появится в Фазе 5.', 'info');
      setPick(null);
      await mutate('/v1/reports/runs');
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mr-fade-up">
      <PageHeader eyebrow="Отчётность" title="Конструктор отчётов" />
      <DemoNote>
        Шаблоны и очередь запросов работают; формирование PDF, Excel и PowerPoint реализуется в Фазе 5.
        Онлайн-версия отчёта открывает раздел «Отчёты и графики» на реальных данных.
      </DemoNote>
      {tpl.error && <ErrorBox message={errorMessage(tpl.error)} onRetry={() => void tpl.mutate()} />}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {!tpl.data && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-44" />)}
        {tpl.data?.items.map((t) => (
          <Card key={t.id} className="group p-5 transition hover:-translate-y-0.5 hover:shadow-pop">
            <div
              className="mb-3 grid size-10 place-items-center rounded-xl text-[18px]"
              style={{ background: `${t.color ?? '#3363ff'}22` }}
              aria-hidden
            >
              {t.icon}
            </div>
            <h3 className="mb-1 text-[14px] font-bold">{t.name}</h3>
            <p className="mb-4 text-[12.5px] leading-relaxed text-muted">{t.description}</p>
            <div className="flex gap-2">
              {can('report:create') && (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    className="flex-1"
                    onClick={() => setPick({ t, format: 'pdf' })}
                  >
                    PDF
                  </Button>
                  <Button size="sm" className="flex-1" onClick={() => setPick({ t, format: 'xlsx' })}>
                    Excel
                  </Button>
                </>
              )}
              <Button size="sm" onClick={() => router.push('/analytics')}>
                Онлайн
              </Button>
            </div>
          </Card>
        ))}
      </div>
      <Card className="overflow-hidden">
        <div className="border-b border-line px-5 py-4 text-[15px] font-bold">Запросы на формирование</div>
        {runs.data && !runs.data.items.length ? (
          <EmptyState
            title="Отчётов пока нет"
            hint="Выберите шаблон и формат — запрос появится в этом списке"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Отчёт</Th>
                  <Th>Тип</Th>
                  <Th>Период</Th>
                  <Th>Статус</Th>
                  <Th>Формат</Th>
                </tr>
              </thead>
              <tbody>
                {!runs.data && (
                  <tr>
                    <td colSpan={5} className="p-4">
                      <Skeleton className="h-16" />
                    </td>
                  </tr>
                )}
                {runs.data?.items.map((r) => (
                  <tr key={r.id} className="border-t border-line">
                    <Td className="font-semibold">{r.name}</Td>
                    <Td className="text-muted">{r.type}</Td>
                    <Td className="font-mono text-[12px] text-muted">
                      {new Date(r.periodFrom).toLocaleDateString('ru-RU')} —{' '}
                      {new Date(r.periodTo).toLocaleDateString('ru-RU')}
                    </Td>
                    <Td>
                      <Badge tone={STATUS[r.status][0]} title={r.error ?? undefined}>
                        {STATUS[r.status][1]}
                      </Badge>
                    </Td>
                    <Td className="font-mono text-[12px] text-muted">
                      {r.format ? `${r.format.toUpperCase()} · ${sizeLabel(r.sizeBytes)}` : '—'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
      <Modal
        open={!!pick}
        onClose={() => setPick(null)}
        title={pick ? `${pick.t.name} · ${pick.format.toUpperCase()}` : ''}
        size="sm"
        footer={
          <>
            <Button onClick={() => setPick(null)}>Отмена</Button>
            <Button variant="primary" loading={busy} onClick={create} disabled={period.from > period.to}>
              Поставить в очередь
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="С">
            {(id) => (
              <Input
                id={id}
                type="date"
                value={period.from}
                max={period.to}
                onChange={(e) => setPeriod({ ...period, from: e.target.value })}
              />
            )}
          </Field>
          <Field label="По">
            {(id) => (
              <Input
                id={id}
                type="date"
                value={period.to}
                min={period.from}
                onChange={(e) => setPeriod({ ...period, to: e.target.value })}
              />
            )}
          </Field>
        </div>
      </Modal>
    </div>
  );
}
