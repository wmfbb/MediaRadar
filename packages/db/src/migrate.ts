import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { syncReferenceData } from './reference';

export const defaultMigrationsDir = (): string =>
  process.env.MIGRATIONS_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

export interface MigrateOptions {
  connectionString: string;
  apiPassword: string;
  workerPassword: string;
  migrationsDir?: string;
  log?: (msg: string) => void;
}

/** Создаёт прикладные роли БД (идемпотентно). Они не владеют таблицами, поэтому подчиняются RLS. */
export async function ensureRoles(client: pg.Client, apiPassword: string, workerPassword: string): Promise<void> {
  for (const [role, pwd] of [
    ['app_api', apiPassword],
    ['app_worker', workerPassword],
  ] as const) {
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    const lit = client.escapeLiteral(pwd);
    if (exists.rowCount) await client.query(`ALTER ROLE ${role} LOGIN PASSWORD ${lit} NOSUPERUSER NOBYPASSRLS`);
    else await client.query(`CREATE ROLE ${role} LOGIN PASSWORD ${lit} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  }
}

/** Применяет SQL-миграции по порядку имён. Изменение уже применённого файла — ошибка (миграции неизменяемы). */
export async function migrate(opts: MigrateOptions): Promise<{ applied: string[] }> {
  const log = opts.log ?? (() => {});
  const dir = opts.migrationsDir ?? defaultMigrationsDir();
  const client = new pg.Client({ connectionString: opts.connectionString, application_name: 'mediaradar-migrate' });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await ensureRoles(client, opts.apiPassword, opts.workerPassword);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prev = done.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`Миграция ${file} изменена после применения. Создайте новую миграцию.`);
        continue;
      }
      log(`→ ${file}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Ошибка в миграции ${file}: ${(err as Error).message}`);
      }
      applied.push(file);
    }
    await syncReferenceData(client);
    return { applied };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(727274)');
    } catch {
      /* соединение могло закрыться */
    }
    await client.end();
  }
}
