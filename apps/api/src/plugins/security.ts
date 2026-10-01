import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError, randomToken, type Config } from '@mediaradar/core';

export const CSRF_COOKIE = 'mr_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function allowedOrigins(config: Config): Set<string> {
  return new Set([new URL(config.APP_BASE_URL).origin, ...config.CORS_ORIGINS]);
}

const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Защита от CSRF для cookie-сессий:
 *  1) для небезопасных методов заголовок Origin (если есть) должен быть из списка разрешённых;
 *  2) если в запросе есть cookie сессии — требуется заголовок X-CSRF-Token, равный cookie mr_csrf (double-submit).
 * Cookie сессии при этом SameSite=Lax и HttpOnly.
 */
export function registerSecurity(app: FastifyInstance, config: Config): void {
  const origins = allowedOrigins(config);
  app.addHook('onRequest', async (req) => {
    if (!UNSAFE.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) throw new AppError('forbidden', 'Недопустимый источник запроса');
    if (!origin && req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('forbidden', 'Недопустимый источник запроса');
    if ((req.routeOptions.config as { csrf?: boolean } | undefined)?.csrf === false) return;
    if (req.cookies[config.SESSION_COOKIE_NAME]) {
      const cookie = req.cookies[CSRF_COOKIE];
      const header = req.headers[CSRF_HEADER];
      if (!cookie || typeof header !== 'string' || !eq(cookie, header)) throw new AppError('forbidden', 'Недействительный CSRF-токен. Обновите страницу.');
    }
  });
}

export const newCsrfToken = (): string => randomToken(24);
