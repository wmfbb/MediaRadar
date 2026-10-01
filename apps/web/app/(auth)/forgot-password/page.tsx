'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Field, Input } from '@mediaradar/ui';
import { AuthCard, AuthForm } from '@/components/auth';
import { api, errorMessage } from '@/lib/api';

export default function Page() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async () => {
    setError(null);
    setLoading(true);
    try {
      await api('/v1/auth/password/forgot', { method: 'POST', body: { email } });
      setDone(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <AuthCard title="Восстановление пароля" subtitle="Отправим ссылку для смены пароля на вашу почту" footer={<Link className="font-semibold text-accent hover:underline" href="/login">← Вернуться ко входу</Link>}>
      {done ? (
        <p className="rounded-lg bg-ok-soft px-4 py-3 text-[13px] text-ok" role="status">Если такой адрес зарегистрирован, письмо со ссылкой уже отправлено. Ссылка действует 1 час.</p>
      ) : (
        <AuthForm onSubmit={submit} error={error} submit="Отправить ссылку" loading={loading}>
          <Field label="Email">{(id) => <Input id={id} type="email" required autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        </AuthForm>
      )}
    </AuthCard>
  );
}
