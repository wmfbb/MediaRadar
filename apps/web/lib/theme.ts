'use client';
import { useEffect, useState } from 'react';
import { api } from './api';

export type ThemeMode = 'light' | 'dark' | 'system';
const KEY = 'mr-theme';

export function applyTheme(mode: ThemeMode): void {
  const dark =
    mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}
export const storedTheme = (): ThemeMode => {
  try {
    return (localStorage.getItem(KEY) as ThemeMode | null) ?? 'system';
  } catch {
    return 'system';
  }
};
/** Сохраняет выбор локально и (для вошедшего пользователя) в личных настройках на сервере. */
export async function setTheme(mode: ThemeMode, persist = true): Promise<void> {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* приватный режим */
  }
  applyTheme(mode);
  if (persist)
    await api('/v1/settings/ui.theme.default', { method: 'PUT', body: { scope: 'user', value: mode } }).catch(
      () => {},
    );
}

export function useThemeMode(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>('system');
  useEffect(() => {
    setMode(storedTheme());
    const onChange = () =>
      document.documentElement.classList.contains('dark') !== undefined && setMode(storedTheme());
    window.addEventListener('storage', onChange);
    return () => window.removeEventListener('storage', onChange);
  }, []);
  return mode;
}

/** Скрипт в <head>: применяет тему до отрисовки, чтобы не было «мигания». */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${KEY}')||'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}})()`;
