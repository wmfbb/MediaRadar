'use client';
import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { ToastProvider } from '@mediaradar/ui';
import { ApiError, fetcher } from '@/lib/api';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        fetcher,
        revalidateOnFocus: false,
        shouldRetryOnError: (e) => !(e instanceof ApiError && e.status < 500),
        errorRetryCount: 2,
      }}
    >
      <ToastProvider>{children}</ToastProvider>
    </SWRConfig>
  );
}
