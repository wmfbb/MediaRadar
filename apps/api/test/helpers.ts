import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { loadConfig } from '@mediaradar/core';
import { createDb, type Db } from '@mediaradar/db';
import { buildApp, type AppOptions } from '../src/app';
import { MemoryBus } from '../src/lib/bus';
import { CaptureMailer } from '../src/lib/mailer';
import { NoQueueStats } from '../src/lib/queue-stats';
import { resetAuthCaches } from '../src/plugins/auth';
import { ADMIN_URL, API_URL, PASSWORD } from './env';

export { PASSWORD };

export interface TestCtx {
  app: FastifyInstance;
  db: Db;
  bus: MemoryBus;
  mailer: CaptureMailer;
  close(): Promise<void>;
}

export async function createTestApp(opts: AppOptions = {}): Promise<TestCtx> {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: API_URL, LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent', APP_BASE_URL: 'http://localhost:3000' });
  const db = createDb(API_URL, { max: 6, applicationName: 'test-api' });
  const bus = new MemoryBus();
  const mailer = new CaptureMailer();
  const noQueues = new NoQueueStats();
  const app = await buildApp({ config, db, bus, mailer, queues: noQueues, jobs: noQueues }, { docs: false, ...opts });
  await app.ready();
  return {
    app, db, bus, mailer,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function setPlatformSetting(key: string, value: unknown): Promise<void> {
  await withAdmin((c) =>
    c.query(
      `INSERT INTO settings (key, scope_type, scope_id, tenant_id, value) VALUES ($1, 'platform', NULL, NULL, $2)
       ON CONFLICT (key, scope_type, (coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)), (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)))
       DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    ),
  );
  resetAuthCaches();
}

/** HTTP-клиент с cookie и автоматической подстановкой CSRF-токена, как у браузера. */
export class Client {
  cookies = new Map<string, string>();
  constructor(private app: FastifyInstance, private origin = 'http://localhost:3000') {}

  get csrf(): string | undefined {
    return this.cookies.get('mr_csrf');
  }

  async request(method: InjectOptions['method'], url: string, body?: unknown, extra: { csrf?: boolean; headers?: Record<string, string> } = {}): Promise<LightMyRequestResponse & { json<T = any>(): T }> {
    const headers: Record<string, string> = { ...(extra.headers ?? {}) };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(String(method));
    if (unsafe) {
      headers.origin ??= this.origin;
      if (extra.csrf !== false && this.csrf) headers['x-csrf-token'] = this.csrf;
    }
    const res = await this.app.inject({ method, url, headers, payload: body as object | undefined });
    for (const c of res.cookies) {
      if (c.value === '' || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res as never;
  }
  get = (url: string) => this.request('GET', url);
  post = (url: string, body?: unknown, extra?: { csrf?: boolean; headers?: Record<string, string> }) => this.request('POST', url, body ?? {}, extra);
  put = (url: string, body?: unknown) => this.request('PUT', url, body ?? {});
  patch = (url: string, body?: unknown) => this.request('PATCH', url, body ?? {});
  delete = (url: string) => this.request('DELETE', url);

  async login(email: string, password = PASSWORD): Promise<this> {
    const res = await this.post('/v1/auth/login', { email, password });
    if (res.statusCode !== 200) throw new Error(`login ${email} failed: ${res.statusCode} ${res.body}`);
    return this;
  }
}

/**
 * Вход пользователя. Многотенантные пользователи при входе попадают в тенант, где работали последним (так же ведёт себя продукт),
 * поэтому тесты явно выбирают рабочий тенант (по умолчанию «Алтайский край»), если он доступен пользователю.
 */
export async function loginAs(ctx: TestCtx, email: string, password = PASSWORD, tenantSlug = 'altai-krai'): Promise<Client> {
  const c = await new Client(ctx.app).login(email, password);
  const me = (await c.get('/v1/auth/me')).json<{ tenant: { slug: string } | null; tenants: Array<{ id: string; slug: string }> }>();
  const want = me.tenants.find((t) => t.slug === tenantSlug);
  if (want && me.tenant?.slug !== tenantSlug) await c.post('/v1/auth/switch-tenant', { tenantId: want.id });
  return c;
}

export async function tenantIds(): Promise<{ A: string; B: string }> {
  return withAdmin(async (c) => {
    const r = await c.query<{ slug: string; id: string }>('SELECT slug, id FROM tenants');
    return { A: r.rows.find((x) => x.slug === 'altai-krai')!.id, B: r.rows.find((x) => x.slug === 'demo-republic')!.id };
  });
}
