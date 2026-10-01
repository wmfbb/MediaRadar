'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Button, EmptyState, Skeleton } from '@mediaradar/ui';
import { Shell } from '@/components/shell';
import { ApiError } from '@/lib/api';
import { LiveProvider } from '@/lib/live';
import { MeProvider, useMeQuery } from '@/lib/me';

/** Защита кабинета: нет сессии → вход; ожидается 2FA → подтверждение; обязательная 2FA не настроена → настройка. */
export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const { data: me, error, mutate, isLoading } = useMeQuery();

  const unauthorized = error instanceof ApiError && error.status === 401;
  useEffect(() => {
    if (unauthorized) router.replace(`/login?next=${encodeURIComponent(path)}`);
    else if (me && !me.mfa.verified) router.replace('/login/mfa');
    else if (me?.mfa.setupRequired && path !== '/security/setup') router.replace('/security/setup');
    else if (me && !me.tenant && me.user.platformRole && !path.startsWith('/admin') && path !== '/account') router.replace('/admin/tenants');
  }, [unauthorized, me, path, router]);

  if (error && !unauthorized) return <div className="grid min-h-screen place-items-center p-6"><EmptyState title="Сервер недоступен" hint="Не удалось связаться с API. Проверьте подключение и повторите." action={<Button variant="primary" onClick={() => void mutate()}>Повторить</Button>} /></div>;
  if (isLoading || !me || unauthorized || !me.mfa.verified || (me.mfa.setupRequired && path !== '/security/setup')) {
    return <div className="grid min-h-screen place-items-center"><div className="w-64 space-y-3"><Skeleton className="h-8" /><Skeleton className="h-4 w-40" /></div></div>;
  }
  if (me.mfa.setupRequired) return <MeProvider me={me} reload={mutate}>{children}</MeProvider>;
  if (!me.tenant && !me.user.platformRole) {
    return (
      <MeProvider me={me} reload={mutate}>
        <div className="grid min-h-screen place-items-center p-6">
          <EmptyState title="Нет доступа ни к одному тенанту" hint="Ваша учётная запись не состоит ни в одном рабочем пространстве или оно приостановлено. Обратитесь к администратору." action={<LogoutButton />} />
        </div>
      </MeProvider>
    );
  }
  return (
    <MeProvider me={me} reload={mutate}>
      {me.tenant ? <LiveProvider tenantId={me.tenant.id}><Shell>{children}</Shell></LiveProvider> : <Shell>{children}</Shell>}
    </MeProvider>
  );
}

function LogoutButton() {
  return <Button variant="primary" onClick={async () => { await fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'x-csrf-token': document.cookie.split('; ').find((c) => c.startsWith('mr_csrf='))?.split('=')[1] ?? '' } }); window.location.href = '/login'; }}>Выйти</Button>;
}
