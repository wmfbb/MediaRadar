import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:4000';
const isProd = process.env.NODE_ENV === 'production';
const wsOrigin = process.env.NEXT_PUBLIC_WS_URL ? new URL(process.env.NEXT_PUBLIC_WS_URL).origin : '';

// CSP: Next.js вставляет inline-скрипты гидратации, поэтому 'unsafe-inline' для script-src (строгий nonce-режим требует динамического рендера).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' ws: wss: ${wsOrigin}`.trim(),
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // standalone-сборка нужна только для Docker-образа (NEXT_OUTPUT=standalone); локально и в CI используется обычный `next start`
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  transpilePackages: ['@mediaradar/ui', '@mediaradar/core'],
  // Браузер обращается к API на том же origin (/api/...) — cookie сессии без CORS. В production это делает Caddy, rewrite — запасной путь.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/:path*` }];
  },
  async headers() {
    const common = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ];
    return [
      {
        source: '/:path*',
        headers: isProd ? [...common, { key: 'Content-Security-Policy', value: csp }] : common,
      },
    ];
  },
};
export default config;
