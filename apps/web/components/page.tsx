import type { ReactNode } from 'react';

/** Заголовок страницы: надзаголовок, название, пояснение, действия справа. */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow: string;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[.14em] text-accent">{eyebrow}</div>
        <h1 className="text-[26px] font-extrabold leading-tight tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-card border border-bad/30 bg-bad-soft p-5 text-[13px] text-bad">
      <div className="font-bold">Не удалось загрузить данные</div>
      <div className="mt-1 opacity-90">{message}</div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-lg border border-bad/40 px-3 py-1.5 text-[12px] font-semibold hover:bg-bad/10"
        >
          Повторить
        </button>
      )}
    </div>
  );
}

export const DemoNote = ({ children }: { children: ReactNode }) => (
  <div className="mb-4 rounded-xl border border-info/30 bg-info-soft px-4 py-3 text-[12.5px] text-info">
    {children}
  </div>
);
