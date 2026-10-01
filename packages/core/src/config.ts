import { z } from 'zod';
import { parseEncryptionKey } from './crypto';

/** Ключ только для разработки и тестов. В production запрещён. */
export const DEV_ENCRYPTION_KEY = 'ZGV2LW9ubHkta2V5LWRvLW5vdC11c2UtaW4tcHJvZCE='; // ровно 32 байта

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Адрес портала для писем и проверки Origin. Не задан — http://localhost:<WEB_PORT>. */
  APP_BASE_URL: z.string().url().optional(),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL обязателен'),
  WORKER_DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  APP_ENCRYPTION_KEY: z.string().default(DEV_ENCRYPTION_KEY),
  SESSION_COOKIE_NAME: z.string().default('mr_session'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  METRICS_TOKEN: z.string().optional(),
  DEMO_LIVE: bool.default(false),
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    ),
  TRUST_PROXY: bool.default(false),
});

export type Config = Omit<z.infer<typeof schema>, 'APP_ENCRYPTION_KEY' | 'APP_BASE_URL'> & {
  APP_ENCRYPTION_KEY: string;
  APP_BASE_URL: string;
  encryptionKey: Buffer;
  isProd: boolean;
  isTest: boolean;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Некорректная конфигурация окружения:\n${msg}`);
  }
  const c = parsed.data;
  const isProd = c.NODE_ENV === 'production';
  if (isProd && c.APP_ENCRYPTION_KEY === DEV_ENCRYPTION_KEY)
    throw new Error('В production нужно задать собственный APP_ENCRYPTION_KEY (openssl rand -base64 32)');
  if (isProd && !c.METRICS_TOKEN) throw new Error('В production нужно задать METRICS_TOKEN');
  const encryptionKey = parseEncryptionKey(c.APP_ENCRYPTION_KEY);
  return {
    ...c,
    APP_BASE_URL: c.APP_BASE_URL ?? `http://localhost:${c.WEB_PORT}`,
    encryptionKey,
    isProd,
    isTest: c.NODE_ENV === 'test',
  };
}
