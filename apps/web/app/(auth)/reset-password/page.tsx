'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Field, Input } from '@mediaradar/ui';
import { AuthCard, AuthForm } from '@/components/auth';
import { api, errorMessage, fieldError } from '@/lib/api';

function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const submit = async () => {
    setErr(null);
    setLoading(true);
    try {
      await api('/v1/auth/password/reset', { method: 'POST', body: { token, password } });
      setDone(true);
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  };
  return (
    <AuthCard
      title="Новый пароль"
      footer={
        <Link className="font-semibold text-accent hover:underline" href="/login">
          Перейти ко входу
        </Link>
      }
    >
      {done ? (
        <p className="rounded-lg bg-ok-soft px-4 py-3 text-[13px] text-ok" role="status">
          Пароль изменён. Все прежние сессии завершены — войдите с новым паролем.
        </p>
      ) : (
        <AuthForm
          onSubmit={submit}
          error={err && !fieldError(err, 'password') ? errorMessage(err) : null}
          submit="Сохранить пароль"
          loading={loading}
        >
          <Field label="Новый пароль" hint="Не короче 10 символов" error={fieldError(err, 'password')}>
            {(id) => (
              <Input
                id={id}
                type="password"
                required
                autoFocus
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
        </AuthForm>
      )}
    </AuthCard>
  );
}
export default function Page() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
