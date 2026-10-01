'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../cn';
import { Icon } from '../icons';

/** Модальное окно на нативном <dialog>: фокус-ловушка, Esc и возврат фокуса обеспечивает браузер. */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="mr-dialog m-auto w-full backdrop:bg-black/50"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-label={title}
    >
      {open && (
        <div
          className={cn(
            'mx-auto flex max-h-[88dvh] w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-card border border-line bg-surface text-fg shadow-pop',
            { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size],
          )}
        >
          <div className="flex items-center justify-between gap-3 border-b border-line px-6 py-4">
            <h3 className="text-[16px] font-bold leading-snug">{title}</h3>
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть"
              className="grid size-8 flex-none place-items-center rounded-lg text-faint hover:bg-surface-2 hover:text-fg"
            >
              <Icon name="x" />
            </button>
          </div>
          <div className="overflow-y-auto p-6">{children}</div>
          {footer && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-surface-2 px-6 py-4">
              {footer}
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}

type ToastKind = 'info' | 'ok' | 'warn' | 'err';
interface ToastItem {
  id: number;
  msg: string;
  kind: ToastKind;
}
const ToastCtx = createContext<(msg: string, kind?: ToastKind) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

const KIND_BORDER: Record<ToastKind, string> = {
  info: 'border-l-accent',
  ok: 'border-l-ok',
  warn: 'border-l-warn',
  err: 'border-l-bad',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((msg: string, kind: ToastKind = 'info') => {
    const id = ++seq.current;
    setItems((x) => [...x.slice(-3), { id, msg, kind }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), kind === 'err' ? 7000 : 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div
        className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-[min(340px,calc(100vw-2.5rem))] flex-col gap-2"
        aria-live="polite"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'err' ? 'alert' : 'status'}
            className={cn(
              'mr-slide-in pointer-events-auto flex gap-3 rounded-xl border border-l-[3px] border-line bg-surface p-3.5 text-fg shadow-pop',
              KIND_BORDER[t.kind],
            )}
          >
            <div className="min-w-0 flex-1 text-[13px] font-semibold leading-snug">{t.msg}</div>
            <button
              type="button"
              aria-label="Закрыть уведомление"
              className="flex-none text-faint hover:text-fg"
              onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
