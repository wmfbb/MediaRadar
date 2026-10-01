'use client';
import { useId, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '../cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-ink-900 text-white hover:bg-ink-800 dark:bg-accent dark:text-on-accent dark:hover:bg-accent-strong',
  accent: 'bg-accent text-on-accent hover:bg-accent-strong',
  secondary: 'border border-line-strong bg-surface text-fg hover:bg-surface-2',
  ghost: 'text-muted hover:bg-surface-2 hover:text-fg',
  danger: 'bg-bad text-white hover:opacity-90 dark:text-on-accent',
};

export function Button({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'px-3.5 py-2 text-[13px]',
        VARIANTS[variant],
        className,
      )}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-card border border-line bg-surface shadow-card', className)} {...rest} />;
}

export function CardHeader({ title, subtitle, right, className }: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 px-5 pt-5', className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-bold leading-tight">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[12px] text-muted">{subtitle}</p>}
      </div>
      {right && <div className="flex-none">{right}</div>}
    </div>
  );
}

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'accent';
const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-info-soft text-info',
  accent: 'bg-accent-soft text-accent',
};
export function Badge({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-[.04em]', TONES[tone], className)} {...rest} />;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('relative h-[22px] w-[38px] flex-none rounded-full transition disabled:cursor-not-allowed disabled:opacity-50', checked ? 'bg-accent' : 'bg-line-strong')}
    >
      <span className={cn('absolute left-0.5 top-0.5 size-[18px] rounded-full bg-white shadow transition-transform', checked && 'translate-x-4')} />
    </button>
  );
}

const fieldBase = 'w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-[13px] text-fg placeholder:text-faint outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60';

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-muted">
        {label}
      </label>
      {children(id)}
      {hint && !error && <p className="mt-1 text-[12px] text-muted">{hint}</p>}
      {error && (
        <p className="mt-1 text-[12px] text-bad" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input className={cn(fieldBase, className)} {...p} />;
export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select className={cn(fieldBase, 'pr-8', className)} {...p} />;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea className={cn(fieldBase, className)} {...p} />;

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }>; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line-strong bg-surface p-0.5 text-[12px] font-semibold">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn('rounded-md px-3 py-1.5 transition', value === o.value ? 'bg-ink-900 text-white dark:bg-accent dark:text-on-accent' : 'text-muted hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string; count?: number }> }) {
  return (
    <div role="tablist" className="flex gap-1 text-[12px] font-semibold">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={cn('rounded-lg border px-3 py-1.5 transition', value === o.value ? 'border-fg text-fg' : 'border-transparent text-muted hover:text-fg')}>
          {o.label}
          {o.count !== undefined && <span className="ml-1 font-mono opacity-60">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Chip({ active, onClick, children, count }: { active?: boolean; onClick?: () => void; children: ReactNode; count?: number }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      className={cn('rounded-full border px-2.5 py-1 text-[12px] font-medium transition', active ? 'border-ink-900 bg-ink-900 text-white dark:border-accent dark:bg-accent dark:text-on-accent' : 'border-line-strong text-fg hover:border-ink-400')}>
      {children}
      {count !== undefined && <span className="ml-1 font-mono opacity-55">{count}</span>}
    </button>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-line', className)} aria-hidden />;
}

export function EmptyState({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <div className="text-[15px] font-bold">{title}</div>
      {hint && <div className="mt-1 max-w-sm text-[13px] text-muted">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Progress({ value, max, tone = 'accent' }: { value: number; max: number | null; tone?: 'accent' | 'ok' | 'warn' | 'bad' }) {
  const pct = max === null || max === 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  const color = pct >= 100 ? 'bg-bad' : pct >= 80 ? 'bg-warn' : { accent: 'bg-accent', ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad' }[tone];
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max ?? undefined}>
      <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Avatar({ name, size = 32, className }: { name: string; size?: number; className?: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  return (
    <span className={cn('inline-grid flex-none place-items-center rounded-full bg-gradient-to-br from-brand-500 to-brand-800 font-bold text-white', className)} style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden>
      {initials || '?'}
    </span>
  );
}

export function Table({ className, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full text-[13px]', className)} {...rest} />;
}
export const Th = ({ className, align = 'left', ...rest }: HTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' }) => (
  <th scope="col" className={cn('bg-surface-2 px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-muted first:pl-5 last:pr-5', align === 'right' ? 'text-right' : 'text-left', className)} {...rest} />
);
export const Td = ({ className, ...rest }: HTMLAttributes<HTMLTableCellElement>) => <td className={cn('px-3 py-3 first:pl-5 last:pr-5', className)} {...rest} />;
