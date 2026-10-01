'use client';
import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { api, fetcher } from './api';
import { applyTheme, setTheme } from './theme';
import type { Me } from './types';

interface MeValue {
  me: Me;
  can: (perm: string) => boolean;
  reload: () => Promise<unknown>;
  logout: () => Promise<void>;
  switchTenant: (tenantId: string) => Promise<void>;
}
const Ctx = createContext<MeValue | null>(null);

export function useMe(): MeValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMe вне MeProvider');
  return v;
}

export function MeProvider({ me, reload, children }: { me: Me; reload: () => Promise<unknown>; children: ReactNode }) {
  const { mutate } = useSWRConfig();
  // серверная тема пользователя применяется после входа (на этом устройстве могла быть другая)
  useEffect(() => {
    void setTheme(me.preferences.theme, false);
    applyTheme(me.preferences.theme);
  }, [me.preferences.theme]);

  const logout = useCallback(async () => {
    await api('/v1/auth/logout', { method: 'POST' }).catch(() => {});
    await mutate(() => true, undefined, { revalidate: false });
    window.location.href = '/login';
  }, [mutate]);

  const switchTenant = useCallback(async (tenantId: string) => {
    await api('/v1/auth/switch-tenant', { method: 'POST', body: { tenantId } });
    await mutate(() => true, undefined, { revalidate: true });
    window.location.href = '/';
  }, [mutate]);

  const perms = new Set(me.permissions);
  return <Ctx.Provider value={{ me, can: (p) => perms.has(p), reload, logout, switchTenant }}>{children}</Ctx.Provider>;
}

/** Загружает /me. 401 — вход не выполнен. */
export function useMeQuery() {
  return useSWR<Me>('/v1/auth/me', fetcher, { shouldRetryOnError: false, revalidateOnFocus: true, dedupingInterval: 5000 });
}
