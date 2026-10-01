import {
  assertScopeAllowed,
  listDefinitions,
  parseSettingValue,
  requireDefinition,
  resolveSetting,
  type ResolveContext,
  type SettingDefinition,
  type SettingScope,
  type StoredSetting,
} from '@mediaradar/settings';
import { AppError } from '@mediaradar/core';
import type { Queryable } from './client';

const ZERO = '00000000-0000-0000-0000-000000000000';

export interface SettingRow extends StoredSetting {
  key: string;
  version: number;
  tenant_id: string | null;
  updated_by: string | null;
  updated_at: Date;
}

export interface SettingTarget {
  key: string;
  scope: SettingScope;
  /** tenant → id тенанта, source → id источника, user → id пользователя; для platform — null. */
  scopeId: string | null;
  /** Тенант, которому принадлежит значение (RLS). Для platform — null; для source может быть null (глобальное переопределение). */
  tenantId: string | null;
}

function checkTarget(t: SettingTarget): SettingDefinition {
  const def = requireDefinition(t.key);
  assertScopeAllowed(def, t.scope);
  if ((t.scope === 'platform') !== (t.scopeId === null))
    throw new AppError('bad_request', 'scopeId обязателен для всех уровней, кроме platform');
  if (t.scope === 'tenant' && t.tenantId !== t.scopeId)
    throw new AppError('bad_request', 'Для уровня tenant tenantId должен совпадать со scopeId');
  if (t.scope === 'user' && !t.tenantId) throw new AppError('bad_request', 'Для уровня user нужен tenantId');
  return def;
}

/** Все видимые (по RLS) значения; ключи можно ограничить. */
export async function loadSettingRows(q: Queryable, keys?: string[]): Promise<SettingRow[]> {
  const r = keys
    ? await q.query<SettingRow>(
        'SELECT key, scope_type, scope_id, tenant_id, value, version, updated_by, updated_at FROM settings WHERE key = ANY($1)',
        [keys],
      )
    : await q.query<SettingRow>(
        'SELECT key, scope_type, scope_id, tenant_id, value, version, updated_by, updated_at FROM settings',
      );
  return r.rows;
}

export interface EffectiveSetting {
  key: string;
  value: unknown;
  from: SettingScope | 'default';
  /** Значения, заданные на каждом уровне (для интерфейса управления). */
  levels: Partial<Record<SettingScope, { value: unknown; version: number; updatedAt: Date }>>;
}

export function effectiveSettings(
  rows: SettingRow[],
  ctx: ResolveContext,
  definitions: SettingDefinition[] = listDefinitions(),
): EffectiveSetting[] {
  const byKey = new Map<string, SettingRow[]>();
  for (const r of rows) (byKey.get(r.key) ?? byKey.set(r.key, []).get(r.key)!).push(r);
  return definitions.map((def) => {
    const own = byKey.get(def.key) ?? [];
    const { value, from } = resolveSetting(def, own, ctx);
    const levels: EffectiveSetting['levels'] = {};
    for (const r of own) {
      const applies =
        r.scope_type === 'platform' ||
        (r.scope_type === 'tenant' && r.scope_id === ctx.tenantId) ||
        (r.scope_type === 'source' && r.scope_id === ctx.sourceId) ||
        (r.scope_type === 'user' && r.scope_id === ctx.userId);
      if (applies) levels[r.scope_type] = { value: r.value, version: r.version, updatedAt: r.updated_at };
    }
    return { key: def.key, value, from, levels };
  });
}

export async function getSetting<T = unknown>(q: Queryable, key: string, ctx: ResolveContext): Promise<T> {
  const def = requireDefinition(key);
  const rows = await loadSettingRows(q, [key]);
  return resolveSetting(def, rows, ctx).value as T;
}

export async function setSetting(
  q: Queryable,
  target: SettingTarget,
  rawValue: unknown,
  opts: { actorId?: string | null; reason?: string | null; expectedVersion?: number | null } = {},
): Promise<{ version: number }> {
  const def = checkTarget(target);
  const value = parseSettingValue(def, rawValue);
  const cur = await q.query<{ id: string; value: unknown; version: number }>(
    `SELECT id, value, version FROM settings
      WHERE key = $1 AND scope_type = $2 AND coalesce(scope_id, $3) = coalesce($4, $3) AND coalesce(tenant_id, $3) = coalesce($5, $3) FOR UPDATE`,
    [target.key, target.scope, ZERO, target.scopeId, target.tenantId],
  );
  const prev = cur.rows[0];
  if (opts.expectedVersion != null && (prev?.version ?? 0) !== opts.expectedVersion)
    throw new AppError(
      'conflict',
      'Настройка была изменена другим пользователем. Обновите страницу и повторите.',
    );
  let version: number;
  if (prev) {
    version = prev.version + 1;
    await q.query(
      'UPDATE settings SET value = $2, version = $3, updated_by = $4, updated_at = now() WHERE id = $1',
      [prev.id, JSON.stringify(value), version, opts.actorId ?? null],
    );
  } else {
    version = 1;
    await q.query(
      'INSERT INTO settings (key, scope_type, scope_id, tenant_id, value, version, updated_by) VALUES ($1, $2, $3, $4, $5, 1, $6)',
      [
        target.key,
        target.scope,
        target.scopeId,
        target.tenantId,
        JSON.stringify(value),
        opts.actorId ?? null,
      ],
    );
  }
  await q.query(
    `INSERT INTO settings_history (key, scope_type, scope_id, tenant_id, old_value, new_value, version, changed_by, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      target.key,
      target.scope,
      target.scopeId,
      target.tenantId,
      prev ? JSON.stringify(prev.value) : null,
      JSON.stringify(value),
      version,
      opts.actorId ?? null,
      opts.reason ?? null,
    ],
  );
  return { version };
}

/** Удаляет значение уровня: поведение возвращается к значению более широкой области или по умолчанию. */
export async function clearSetting(
  q: Queryable,
  target: SettingTarget,
  opts: { actorId?: string | null; reason?: string | null } = {},
): Promise<boolean> {
  checkTarget(target);
  const r = await q.query<{ value: unknown; version: number }>(
    `DELETE FROM settings WHERE key = $1 AND scope_type = $2 AND coalesce(scope_id, $3) = coalesce($4, $3) AND coalesce(tenant_id, $3) = coalesce($5, $3)
     RETURNING value, version`,
    [target.key, target.scope, ZERO, target.scopeId, target.tenantId],
  );
  const old = r.rows[0];
  if (!old) return false;
  await q.query(
    `INSERT INTO settings_history (key, scope_type, scope_id, tenant_id, old_value, new_value, version, changed_by, reason)
     VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8)`,
    [
      target.key,
      target.scope,
      target.scopeId,
      target.tenantId,
      JSON.stringify(old.value),
      old.version + 1,
      opts.actorId ?? null,
      opts.reason ?? 'сброс к значению по умолчанию',
    ],
  );
  return true;
}

export interface SettingHistoryRow {
  id: string;
  key: string;
  scope_type: SettingScope;
  scope_id: string | null;
  tenant_id: string | null;
  old_value: unknown;
  new_value: unknown;
  version: number;
  changed_by: string | null;
  reason: string | null;
  ts: Date;
}

export async function settingHistory(
  q: Queryable,
  key: string,
  scope: SettingScope,
  scopeId: string | null,
  limit = 50,
): Promise<SettingHistoryRow[]> {
  const r = await q.query<SettingHistoryRow>(
    `SELECT * FROM settings_history WHERE key = $1 AND scope_type = $2 AND coalesce(scope_id, $3) = coalesce($4, $3) ORDER BY ts DESC, version DESC LIMIT $5`,
    [key, scope, ZERO, scopeId, limit],
  );
  return r.rows;
}

/** Откат: возвращает значение, которое было до указанной записи истории (если его не было — удаляет значение). */
export async function rollbackSetting(
  q: Queryable,
  historyId: string,
  opts: { actorId?: string | null } = {},
): Promise<void> {
  const h = (await q.query<SettingHistoryRow>('SELECT * FROM settings_history WHERE id = $1', [historyId]))
    .rows[0];
  if (!h) throw new AppError('not_found', 'Запись истории не найдена');
  const target: SettingTarget = {
    key: h.key,
    scope: h.scope_type,
    scopeId: h.scope_id,
    tenantId: h.tenant_id,
  };
  const reason = `откат изменения v${h.version}`;
  if (h.old_value === null || h.old_value === undefined)
    await clearSetting(q, target, { actorId: opts.actorId, reason });
  else await setSetting(q, target, h.old_value, { actorId: opts.actorId, reason });
}
