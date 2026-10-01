'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

/** Параметр периода в URL (?range=7d): ссылкой на дашборд можно делиться. */
export function useUrlParam<T extends string>(
  name: string,
  fallback: T,
  allowed: readonly T[],
): [T, (v: T) => void] {
  const sp = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const raw = sp.get(name) as T | null;
  const value = raw && allowed.includes(raw) ? raw : fallback;
  const set = useCallback(
    (v: T) => {
      const next = new URLSearchParams(sp.toString());
      next.set(name, v);
      router.replace(`${path}?${next.toString()}`, { scroll: false });
    },
    [sp, router, path, name],
  );
  return [value, set];
}
