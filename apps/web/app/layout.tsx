import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import { Providers } from './providers';

export const metadata: Metadata = { title: { default: 'МедиаРадар', template: '%s · МедиаРадар' }, description: 'Платформа региональной медиа-аналитики' };
export const viewport: Viewport = { themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f5f7fa' }, { media: '(prefers-color-scheme: dark)', color: '#0a1020' }] };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
