'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import useSWR from 'swr';
import { Button, Field, Input, Skeleton } from '@mediaradar/ui';
import { AuthCard, AuthForm } from '@/components/auth';
import { api, errorMessage, fieldError } from '@/lib/api';

interface Invite {
  email: string;
  tenantName: string;
  roleName: string;
  accountExists: boolean;
}

function InviteForm() {
  const token = useSearchParams().get('token') ?? '';
  const { data, error } = useSWR<Invite>(token ? `/v1/auth/invitations/${token}` : null, {
    shouldRetryOnError: false,
  });
  const [f, setF] = useState({ name: '', password: '' });
  const [err, setErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const submit = async () => {
    setErr(null);
    setLoading(true);
    try {
      await api('/v1/auth/invitations/accept', {
        method: 'POST',
        body: data?.accountExists ? { token } : { token, ...f },
      });
      window.location.assign('/');
    } catch (e) {
      setErr(e);
      setLoading(false);
    }
  };
  if (!token || error)
    return (
      <AuthCard
        title="Приглашение недействительно"
        subtitle="Ссылка устарела или уже использована. Попросите администратора прислать новое приглашение."
        footer={
          <Link className="font-semibold text-accent hover:underline" href="/login">
            Ко входу
          </Link>
        }
      >
        <span />
      </AuthCard>
    );
  if (!data)
    return (
      <AuthCard title="Приглашение">
        <Skeleton className="h-24" />
      </AuthCard>
    );
  return (
    <AuthCard
      title={`Приглашение в «${data.tenantName}»`}
      subtitle={
        <>
          Роль: <b>{data.roleName}</b> · {data.email}
        </>
      }
    >
      {data.accountExists ? (
        <div className="space-y-4">
          <p className="text-[13px] text-muted">
            Для этого адреса уже есть аккаунт. Войдите в него и откройте ссылку-приглашение ещё раз, либо
            примите приглашение, если вход уже выполнен.
          </p>
          {err ? (
            <p role="alert" className="text-[13px] text-bad">
              {errorMessage(err)}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button variant="primary" onClick={submit} loading={loading}>
              Принять приглашение
            </Button>
            <Link
              href={`/login?next=${encodeURIComponent(`/accept-invite?token=${token}`)}`}
              className="rounded-lg border border-line-strong px-3.5 py-2 text-[13px] font-semibold hover:bg-surface-2"
            >
              Войти
            </Link>
          </div>
        </div>
      ) : (
        <AuthForm
          onSubmit={submit}
          error={err && !fieldError(err, 'password') ? errorMessage(err) : null}
          submit="Создать аккаунт и принять"
          loading={loading}
        >
          <Field label="Ваше имя">
            {(id) => (
              <Input
                id={id}
                required
                autoFocus
                autoComplete="name"
                value={f.name}
                onChange={(e) => setF({ ...f, name: e.target.value })}
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
                onChange={(e) => setF({ ...f, password: e.target.value })}
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
      <InviteForm />
    </Suspense>
  );
}
