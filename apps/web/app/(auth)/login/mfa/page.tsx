'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Field, Input } from '@mediaradar/ui';
import { AuthCard, AuthForm, safeNext } from '@/components/auth';
import { api, errorMessage } from '@/lib/api';

function MfaForm() {
  const next = safeNext(useSearchParams().get('next'));
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async () => {
    setError(null);
    setLoading(true);
    try {
      await api('/v1/auth/mfa/verify', { method: 'POST', body: useRecovery ? { recoveryCode: code } : { code } });
      window.location.assign(next);
    } catch (e) {
      setError(errorMessage(e));
      setLoading(false);
    }
  };
  return (
    <AuthCard title="Подтверждение входа" subtitle={useRecovery ? 'Введите один из резервных кодов' : 'Введите 6-значный код из приложения-аутентификатора'}
      footer={<button type="button" className="font-semibold text-accent hover:underline" onClick={() => { setUseRecovery((v) => !v); setCode(''); setError(null); }}>{useRecovery ? 'Использовать код из приложения' : 'Использовать резервный код'}</button>}>
      <AuthForm onSubmit={submit} error={error} submit="Подтвердить" loading={loading}>
        <Field label={useRecovery ? 'Резервный код' : 'Код'}>
          {(id) => <Input id={id} autoFocus required inputMode={useRecovery ? 'text' : 'numeric'} autoComplete="one-time-code" maxLength={useRecovery ? 12 : 6} value={code} onChange={(e) => setCode(e.target.value.trim())} className="text-center font-mono text-[18px] tracking-[.3em]" />}
        </Field>
      </AuthForm>
    </AuthCard>
  );
}
export default function Page() {
  return <Suspense><MfaForm /></Suspense>;
}
