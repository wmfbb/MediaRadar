'use client';
import { SENTIMENTS, type SentimentLabel } from '@mediaradar/core/domain';
import { Badge, cn } from '@mediaradar/ui';
import { useId } from 'react';
import { pctDelta } from '@/lib/format';

export const SENT_TONE: Record<SentimentLabel, 'ok' | 'ok' | 'neutral' | 'warn' | 'bad'> = { VP: 'ok', P: 'ok', N: 'neutral', NG: 'warn', VN: 'bad' };

export function SentimentBadge({ label, className }: { label: SentimentLabel; className?: string }) {
  return <Badge tone={SENT_TONE[label]} className={className}>{SENTIMENTS[label].short}</Badge>;
}

export function Delta({ value, goodWhenUp }: { value: number | null; goodWhenUp: boolean }) {
  const text = pctDelta(value);
  if (!text) return null;
  const good = (value ?? 0) === 0 ? null : (value! > 0) === goodWhenUp;
  return <Badge tone={good === null ? 'neutral' : good ? 'ok' : 'bad'}>{text}</Badge>;
}

/** Интенсивность на шкале от нуля до максимума: цвет акцента, смешанный с фоном (работает в обеих темах). */
export const heatStyle = (value: number, max: number) => {
  const r = max > 0 ? value / max : 0;
  return { background: value === 0 ? 'var(--surface-2)' : `color-mix(in srgb, var(--accent) ${Math.round(14 + r * 86)}%, var(--surface))`, color: r > 0.5 ? '#fff' : 'var(--muted)' };
};

/** Миниатюра материала: градиент цвета темы с узором (в прототипе — тот же приём, реальные изображения появятся в Фазе 1). */
export function Thumb({ color, label, className }: { color: string; label: string; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 320 120" preserveAspectRatio="none" className={cn('block h-[120px] w-full', className)} role="img" aria-label={`Тема: ${label}`}>
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor={color} /><stop offset="100%" stopColor="#0f172a" /></linearGradient>
        <pattern id={`p${id}`} width="26" height="26" patternUnits="userSpaceOnUse"><circle cx="13" cy="13" r="1.4" fill="rgba(255,255,255,.16)" /></pattern>
      </defs>
      <rect width="320" height="120" fill={`url(#g${id})`} />
      <rect width="320" height="120" fill={`url(#p${id})`} />
      <path d="M0 96 L54 66 L104 84 L160 44 L214 68 L268 34 L320 58 L320 120 L0 120 Z" fill="rgba(255,255,255,.10)" />
      <text x="16" y="30" fill="rgba(255,255,255,.92)" fontFamily="Inter Variable, sans-serif" fontSize="12" fontWeight="800" letterSpacing="1.4">{label.toUpperCase()}</text>
    </svg>
  );
}
