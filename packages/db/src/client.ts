import pg from 'pg';

// bigint → number (счётчики), numeric → number. Для наших объёмов точности хватает.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export type Queryable = {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>;
};

export interface TenantContext {
  tenantId: string;
  userId?: string | null;
  /** Платформенный администратор: RLS пропускает все тенанты. Выставлять только после проверки права platform:*. */
  platformAdmin?: boolean;
}

export interface RunOptions {
  readOnly?: boolean;
}

export interface Db {
  pool: pg.Pool;
  /** Транзакция в контексте тенанта (RLS по app.tenant_id). */
  tenant<T>(ctx: TenantContext, fn: (q: Queryable) => Promise<T>, opts?: RunOptions): Promise<T>;
  /** Системный контекст: вход, регистрация, приглашения — до определения тенанта. Использовать только в модуле аутентификации. */
  system<T>(fn: (q: Queryable) => Promise<T>, opts?: RunOptions): Promise<T>;
  /** Платформенный администратор без привязки к тенанту. */
  platform<T>(userId: string, fn: (q: Queryable) => Promise<T>, opts?: RunOptions): Promise<T>;
  /** Воркеры и скрипты: без контекста (для роли app_worker политики общего слоя открыты). */
  raw<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createDb(
  connectionString: string,
  opts: { max?: number; applicationName?: string } = {},
): Db {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'mediaradar',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', () => {
    /* ошибки idle-клиентов не должны ронять процесс; следующий запрос получит новое соединение */
  });

  async function run<T>(
    settings: Record<string, string>,
    fn: (q: Queryable) => Promise<T>,
    o: RunOptions = {},
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query(o.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      for (const [k, v] of Object.entries(settings))
        await client.query('SELECT set_config($1, $2, true)', [k, v]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* соединение уже недоступно */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    pool,
    tenant: (ctx, fn, o) =>
      run(
        {
          'app.tenant_id': ctx.tenantId,
          'app.user_id': ctx.userId ?? '',
          'app.platform_admin': ctx.platformAdmin ? 'on' : '',
        },
        fn,
        o,
      ),
    system: (fn, o) => run({ 'app.system': 'on' }, fn, o),
    platform: (userId, fn, o) => run({ 'app.user_id': userId, 'app.platform_admin': 'on' }, fn, o),
    raw: (fn) => run({}, fn),
    ping: async () => {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
    close: () => pool.end(),
  };
}
