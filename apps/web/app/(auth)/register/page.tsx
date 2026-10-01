'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Field, Input } from '@mediaradar/ui';
import { AuthCard, AuthForm } from '@/components/auth';
import { api, errorMessage, fieldError } from '@/lib/api';

export default function Page() {
  const [f, setF] = useState({ name: '', workspaceName: '', email: '', password: '' });
  const [err, setErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    setErr(null);
    setLoading(true);
    try {
      await api('/v1/auth/register', { method: 'POST', body: f });
      window.location.assign('/');
    } catch (e) {
      setErr(e);
      setLoading(false);
    }
  };
  return (
    <AuthCard
      title="Регистрация"
      subtitle="Создайте рабочее пространство — вы станете его владельцем"
      footer={
        <>
          Уже есть аккаунт?{' '}
          <Link className="font-semibold text-accent hover:underline" href="/login">
            Войти
          </Link>
        </>
      }
    >
      <AuthForm
        onSubmit={submit}
        error={err && !fieldError(err, 'password') && !fieldError(err, 'email') ? errorMessage(err) : null}
        submit="Создать аккаунт"
        loading={loading}
      >
        <Field label="Ваше имя" error={fieldError(err, 'name')}>
          {(id) => <Input id={id} required autoComplete="name" value={f.name} onChange={set('name')} />}
        </Field>
        <Field
          label="Название пространства"
          hint="Например, название региона или организации"
          error={fieldError(err, 'workspaceName')}
        >
          {(id) => <Input id={id} required value={f.workspaceName} onChange={set('workspaceName')} />}
        </Field>
        <Field label="Email" error={fieldError(err, 'email')}>
          {(id) => (
            <Input
              id={id}
              type="email"
              required
              autoComplete="username"
              value={f.email}
              onChange={set('email')}
            />
          )}
        </Field>
        <Field label="Пароль" hint="Не короче 10 символов" error={fieldError(err, 'password')}>
          {(id) => (
            <Input
              id={id}
              type="password"
              required
              autoComplete="new-password"
              value={f.password}
              onChange={set('password')}
            />
          )}
        </Field>
      </AuthForm>
    </AuthCard>
  );
}
