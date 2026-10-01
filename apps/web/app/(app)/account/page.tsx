'use client';
import { useState } from 'react';
import { Badge, Button, Card, Field, Input, Modal, useToast } from '@mediaradar/ui';
import { PageHeader } from '@/components/page';
import { TwoFactorSetup } from '@/components/two-factor';
import { api, errorMessage, fieldError } from '@/lib/api';
import { useMe } from '@/lib/me';

export default function Page() {
  const { me, reload } = useMe();
  const toast = useToast();
  const [pw, setPw] = useState({ current: '', next: '' });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const [disable, setDisable] = useState(false);
  const [d, setD] = useState({ password: '', code: '' });

  const changePassword = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api('/v1/auth/password/change', { method: 'POST', body: pw });
      toast('Пароль изменён, остальные сессии завершены', 'ok');
      setPw({ current: '', next: '' });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const disable2fa = async () => {
    try {
      await api('/v1/auth/2fa/disable', { method: 'POST', body: d });
      toast('Двухфакторная защита отключена', 'ok');
      setDisable(false);
      setD({ password: '', code: '' });
      await reload();
    } catch (e) { toast(errorMessage(e), 'err'); }
  };

  return (
    <div className="mr-fade-up">
      <PageHeader eyebrow="Аккаунт" title="Профиль и безопасность" />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-4 text-[15px] font-bold">Профиль</h2>
          <dl className="space-y-3 text-[13px]">
            {[['Имя', me.user.name], ['Email', me.user.email], ['Рабочий тенант', me.tenant?.name ?? '—'], ['Роль', me.role?.name ?? me.user.platformRole ?? '—']].map(([k, v]) => <div key={k} className="flex justify-between gap-4"><dt className="text-muted">{k}</dt><dd className="font-semibold">{v}</dd></div>)}
          </dl>
        </Card>
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between"><h2 className="text-[15px] font-bold">Двухфакторная аутентификация</h2><Badge tone={me.mfa.enrolled ? 'ok' : 'warn'}>{me.mfa.enrolled ? 'включена' : 'выключена'}</Badge></div>
          <p className="mb-4 text-[13px] text-muted">Код из приложения-аутентификатора запрашивается при каждом входе. Резервные коды помогут, если телефон недоступен.</p>
          {me.mfa.enrolled ? <Button onClick={() => setDisable(true)}>Отключить</Button> : <Button variant="primary" onClick={() => setSetup(true)}>Включить</Button>}
        </Card>
        <Card className="p-5 xl:col-span-2">
          <h2 className="mb-4 text-[15px] font-bold">Смена пароля</h2>
          <form className="grid max-w-2xl gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void changePassword(); }}>
            <Field label="Текущий пароль" error={err && !fieldError(err, 'next') ? errorMessage(err) : null}>{(id) => <Input id={id} type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />}</Field>
            <Field label="Новый пароль" hint="Не короче 10 символов" error={fieldError(err, 'next')}>{(id) => <Input id={id} type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />}</Field>
            <div className="sm:col-span-2"><Button type="submit" variant="primary" loading={busy} disabled={!pw.current || !pw.next}>Изменить пароль</Button></div>
          </form>
        </Card>
      </div>
      <Modal open={setup} onClose={() => setSetup(false)} title="Включение двухфакторной защиты" size="md">
        {setup && <TwoFactorSetup onDone={async () => { setSetup(false); await reload(); }} />}
      </Modal>
      <Modal open={disable} onClose={() => setDisable(false)} title="Отключение 2FA" size="sm" footer={<><Button onClick={() => setDisable(false)}>Отмена</Button><Button variant="danger" onClick={() => void disable2fa()} disabled={!d.password || d.code.length !== 6}>Отключить</Button></>}>
        <div className="space-y-4"><Field label="Пароль">{(id) => <Input id={id} type="password" value={d.password} onChange={(e) => setD({ ...d, password: e.target.value })} />}</Field><Field label="Код из приложения">{(id) => <Input id={id} inputMode="numeric" maxLength={6} value={d.code} onChange={(e) => setD({ ...d, code: e.target.value.trim() })} className="font-mono tracking-[.3em]" />}</Field></div>
      </Modal>
    </div>
  );
}
