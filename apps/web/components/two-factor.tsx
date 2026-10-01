'use client';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Badge, Button, Field, Input, useToast } from '@mediaradar/ui';
import { api, errorMessage } from '@/lib/api';

/** Настройка 2FA: секрет и QR → подтверждение кодом → показ резервных кодов (один раз). */
export function TwoFactorSetup({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qr, setQr] = useState<string>('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ secret: string; otpauthUrl: string }>('/v1/auth/2fa/setup', { method: 'POST' })
      .then(async (s) => { setSetup(s); setQr(await QRCode.toDataURL(s.otpauthUrl, { margin: 1, width: 192 })); })
      .catch((e) => toast(errorMessage(e), 'err'));
  }, [toast]);

  const enable = async () => {
    setBusy(true);
    try {
      const r = await api<{ recoveryCodes: string[] }>('/v1/auth/2fa/enable', { method: 'POST', body: { code } });
      setCodes(r.recoveryCodes);
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  if (codes)
    return (
      <div className="space-y-4">
        <p className="rounded-lg bg-ok-soft px-4 py-3 text-[13px] text-ok" role="status">Двухфакторная защита включена.</p>
        <div>
          <div className="mb-1 text-[13px] font-bold">Резервные коды</div>
          <p className="mb-2 text-[12px] text-muted">Сохраните их в надёжном месте: каждый код работает один раз и нужен, если вы потеряете телефон. Повторно они не показываются.</p>
          <ul className="grid grid-cols-2 gap-2 rounded-lg bg-surface-2 p-3 font-mono text-[13px]">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
          <Button className="mt-2" size="sm" onClick={() => void navigator.clipboard.writeText(codes.join('\n')).then(() => toast('Коды скопированы', 'ok'))}>Скопировать</Button>
        </div>
        <Button variant="primary" onClick={onDone}>Продолжить</Button>
      </div>
    );

  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted">
        <li>Установите приложение-аутентификатор (Яндекс Ключ, Google Authenticator, Aegis и т.п.).</li>
        <li>Отсканируйте QR-код или введите ключ вручную.</li>
        <li>Введите 6-значный код из приложения.</li>
      </ol>
      <div className="flex flex-wrap items-center gap-5">
        {qr ? <img src={qr} alt="QR-код для приложения-аутентификатора" width={192} height={192} className="rounded-lg border border-line bg-white p-1" /> : <div className="size-48 animate-pulse rounded-lg bg-line" />}
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-wider text-muted">Ключ для ручного ввода</div>
          <code className="mt-1 block break-all rounded bg-surface-2 px-2 py-1.5 font-mono text-[12px]">{setup?.secret ?? '…'}</code>
          <Badge tone="info" className="mt-2">SHA-1 · 6 цифр · 30 сек</Badge>
        </div>
      </div>
      <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void enable(); }}>
        <div className="w-40"><Field label="Код">{(id) => <Input id={id} inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.trim())} className="text-center font-mono tracking-[.3em]" />}</Field></div>
        <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>Включить</Button>
      </form>
    </div>
  );
}
