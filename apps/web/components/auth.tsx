'use client';
import type { FormEvent, ReactNode } from 'react';
import { Button, Card, Icon } from '@mediaradar/ui';

export function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-700 text-[17px] font-extrabold text-white shadow-lg">М</div>
          <div>
            <div className="text-[18px] font-extrabold leading-tight tracking-tight">МедиаРадар</div>
            <div className="text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Regional Intelligence</div>
          </div>
        </div>
        <Card className="p-7">
          <h1 className="text-[20px] font-extrabold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </Card>
        {footer && <div className="mt-4 text-center text-[13px] text-muted">{footer}</div>}
      </div>
    </div>
  );
}

export function AuthForm({ onSubmit, error, children, submit, loading }: { onSubmit: () => void; error?: string | null; children: ReactNode; submit: string; loading?: boolean }) {
  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); onSubmit(); }} className="space-y-4" noValidate>
      {error && (
        <div role="alert" className="flex gap-2 rounded-lg border border-bad/30 bg-bad-soft px-3 py-2.5 text-[13px] text-bad">
          <Icon name="alert" className="mt-0.5 flex-none" /> <span>{error}</span>
        </div>
      )}
      {children}
      <Button type="submit" variant="primary" className="w-full" loading={loading}>{submit}</Button>
    </form>
  );
}

/** Защита от open redirect: допускаются только пути внутри приложения. */
export const safeNext = (raw: string | null): string => (raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\') ? raw : '/');
