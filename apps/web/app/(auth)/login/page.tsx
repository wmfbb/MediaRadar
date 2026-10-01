'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Field, Input } from '@mediaradar/ui';
import { AuthCard, AuthForm, safeNext } from '@/components/auth';
import { api, errorMessage } from '@/lib/api';

function LoginForm() {
  const next = safeNext(useSearchParams().get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError(null);
    setLoading(true);
    try {
      const r = await api<{ status: 'ok' | 'mfa_required' }>('/v1/auth/login', { method: 'POST', body: { email, password } });
      window.location.assign(r.status === 'mfa_required' ? `/login/mfa?next=${encodeURIComponent(next)}` : next);
    } catch (e) {
      setError(errorMessage(e));
      setLoading(false);
    }
  };

  return (
    <AuthCard title="Вход в систему" subtitle="Региональная медиа-аналитика" footer={<>Нет аккаунта? <Link className="font-semibold text-accent hover:underline" href="/register">Зарегистрироваться</Link></>}>
      <AuthForm onSubmit={submit} error={error} submit="Войти" loading={loading}>
        <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Пароль">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <div className="text-right text-[13px]"><Link className="text-muted hover:text-accent hover:underline" href="/forgot-password">Забыли пароль?</Link></div>
      </AuthForm>
    </AuthCard>
  );
}
export default function Page() {
  return <Suspense><LoginForm /></Suspense>;
}
