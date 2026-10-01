'use client';
import { Card } from '@mediaradar/ui';
import { TwoFactorSetup } from '@/components/two-factor';
import { useMe } from '@/lib/me';

/** Обязательная настройка 2FA для ролей, где она требуется (до этого остальные разделы закрыты). */
export default function Page() {
  const { me, reload, logout } = useMe();
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <Card className="w-full max-w-xl p-7">
        <h1 className="text-[20px] font-extrabold tracking-tight">Включите двухфакторную защиту</h1>
        <p className="mb-5 mt-1 text-[13px] text-muted">Для роли «{me.role?.name ?? me.user.platformRole}» двухфакторная аутентификация обязательна. Без неё остальные разделы недоступны.</p>
        <TwoFactorSetup onDone={async () => { await reload(); window.location.assign('/'); }} />
        <button type="button" onClick={() => void logout()} className="mt-5 text-[13px] text-muted hover:text-fg hover:underline">Выйти</button>
      </Card>
    </div>
  );
}
