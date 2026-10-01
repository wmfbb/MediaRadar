'use client';
import useSWR from 'swr';
import { Badge, Button, Card, Progress, Skeleton, Table, Td, Th, cn, useToast } from '@mediaradar/ui';
import { DemoNote, ErrorBox, PageHeader } from '@/components/page';
import { ApiError, api, errorMessage } from '@/lib/api';
import { dateTime, money, num } from '@/lib/format';
import { useMe } from '@/lib/me';

interface Plan {
  key: string;
  name: string;
  priceMinor: number | null;
  description: string;
  features: string[];
}
interface Sub {
  plan: { key: string; name: string };
  status: string;
  periodEnd: string | null;
  meters: Array<{ key: string; limit: number | null; used: number }>;
  features: Record<string, boolean>;
}
interface Payment {
  id: string;
  provider: string;
  description: string;
  methodLabel: string | null;
  amountMinor: number;
  currency: string;
  status: 'paid' | 'refunded' | 'pending' | 'failed';
  createdAt: string;
}
const METER_LABEL: Record<string, string> = {
  'sources.active': 'Источники',
  'articles.delivered_per_month': 'Материалов в месяц',
  seats: 'Пользователи',
  'ai.tokens_per_month': 'AI-токены в месяц',
  'history.depth_days': 'Глубина архива, дн.',
  'reports.per_month': 'Отчётов в месяц',
  'exports.per_month': 'Экспортов в месяц',
  'alerts.rules': 'Правил алертов',
  'api.requests_per_month': 'API-запросов в месяц',
};
const PAY = {
  paid: ['ok', 'Оплачен'],
  refunded: ['warn', 'Возврат'],
  pending: ['info', 'Ожидает'],
  failed: ['bad', 'Ошибка'],
} as const;

export default function Page() {
  const { can } = useMe();
  const toast = useToast();
  const plans = useSWR<{ items: Plan[] }>('/v1/billing/plans');
  const sub = useSWR<Sub>('/v1/billing/subscription');
  const pays = useSWR<{ items: Payment[] }>(can('billing:manage') ? '/v1/billing/payments' : null);

  const choose = async (planKey: string) => {
    try {
      await api('/v1/billing/checkout', { method: 'POST', body: { planKey } });
    } catch (e) {
      toast(
        e instanceof ApiError && e.status === 501
          ? 'Онлайн-оплата подключается в Фазе 8 (ЮKassa). Сейчас тариф меняет администратор платформы.'
          : errorMessage(e),
        e instanceof ApiError && e.status === 501 ? 'info' : 'err',
      );
    }
  };
  return (
    <div className="mr-fade-up">
      <PageHeader
        eyebrow="Подписка"
        title="Тарифы и оплата"
        subtitle="Эквайринг: ЮKassa (подключение в Фазе 8) · СБП, карты РФ, счета для юрлиц"
      />
      <DemoNote>
        Тарифы, лимиты и учёт использования работают; платежи в таблице — тестовые записи демо-данных.
        Онлайн-оплата появится после регистрации юрлица и подключения магазина ЮKassa.
      </DemoNote>
      {(plans.error || sub.error) && <ErrorBox message={errorMessage(plans.error ?? sub.error)} />}
      {sub.data && (
        <Card className="mb-6 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[15px] font-bold">Использование: тариф {sub.data.plan.name}</h2>
            {sub.data.periodEnd && (
              <span className="text-[12px] text-muted">
                Период оплачен до {new Date(sub.data.periodEnd).toLocaleDateString('ru-RU')}
              </span>
            )}
          </div>
          <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
            {sub.data.meters.map((m) => (
              <div key={m.key}>
                <div className="mb-1 flex justify-between text-[12px]">
                  <span className="text-muted">{METER_LABEL[m.key] ?? m.key}</span>
                  <span className="font-mono font-semibold">
                    {num(m.used)} / {m.limit === null ? 'без лимита' : num(m.limit)}
                  </span>
                </div>
                <Progress value={m.used} max={m.limit} />
              </div>
            ))}
          </div>
        </Card>
      )}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {!plans.data && Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-72" />)}
        {plans.data?.items.map((p) => {
          const current = sub.data?.plan.key === p.key;
          return (
            <div
              key={p.key}
              className={cn(
                'relative rounded-card border p-5',
                current
                  ? 'border-accent bg-gradient-to-b from-accent-soft to-surface shadow-pop'
                  : 'border-line bg-surface shadow-card',
              )}
            >
              {current && (
                <Badge tone="accent" className="absolute -top-2.5 left-5 !bg-accent !text-on-accent">
                  текущий тариф
                </Badge>
              )}
              <div
                className={cn(
                  'text-[12px] font-bold uppercase tracking-wider',
                  current ? 'text-accent' : 'text-muted',
                )}
              >
                {p.name}
              </div>
              <div className="mt-1 text-[26px] font-extrabold tracking-tight">
                {money(p.priceMinor)}
                {p.priceMinor !== null && <span className="text-[12px] font-semibold text-faint">/мес</span>}
              </div>
              <div className="mb-4 text-[12.5px] text-muted">{p.description}</div>
              <ul className="mb-5 space-y-1.5">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2 text-[12.5px]">
                    <span className="flex-none text-ok" aria-hidden>
                      ✓
                    </span>
                    {f}
                  </li>
                ))}
              </ul>
              <Button
                variant={current ? 'secondary' : 'primary'}
                className="w-full"
                disabled={current || !can('billing:manage')}
                onClick={() => void choose(p.key)}
              >
                {current ? 'Активен' : 'Выбрать тариф'}
              </Button>
            </div>
          );
        })}
      </div>
      {can('billing:manage') && (
        <Card className="overflow-hidden">
          <div className="border-b border-line px-5 py-4 text-[15px] font-bold">История платежей</div>
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Дата</Th>
                  <Th>Описание</Th>
                  <Th>Способ</Th>
                  <Th align="right">Сумма</Th>
                  <Th>Статус</Th>
                </tr>
              </thead>
              <tbody>
                {pays.data?.items.map((p) => (
                  <tr key={p.id} className="border-t border-line">
                    <Td className="font-mono text-[12px] text-muted">{dateTime(p.createdAt)}</Td>
                    <Td className="font-semibold">{p.description}</Td>
                    <Td className="text-muted">
                      {p.methodLabel ?? '—'} <Badge className="ml-1">{p.provider}</Badge>
                    </Td>
                    <Td className="text-right font-mono font-bold">{money(p.amountMinor, p.currency)}</Td>
                    <Td>
                      <Badge tone={PAY[p.status][0]}>{PAY[p.status][1]}</Badge>
                    </Td>
                  </tr>
                ))}
                {!pays.data && (
                  <tr>
                    <td colSpan={5} className="p-4">
                      <Skeleton className="h-16" />
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}
