import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '@mediaradar/core';
import type { Permission } from '@mediaradar/rbac';
import { GROUP_TITLES, listDefinitions, requireDefinition, type SettingDefinition, type SettingScope } from '@mediaradar/settings';
import {
  clearSetting, effectiveSettings, loadSettingRows, rollbackSetting, setSetting, settingHistory, type Db, type Queryable, type SettingTarget,
} from '@mediaradar/db';
import { audit } from '../lib/audit';
import { uuidParam } from '../lib/http';
import { requireAuth, type Access, type AuthContext } from '../plugins/auth';
import { resetAuthCaches } from '../plugins/auth';

const scopeSchema = z.enum(['platform', 'tenant', 'source', 'user']);

/** Какие уровни пользователь может менять для данной настройки. */
function editableScopes(def: SettingDefinition, a: AuthContext): SettingScope[] {
  return def.scopes.filter((s) => {
    const p = def.editPermission[s];
    if (p === 'self') return true;
    if (!p) return false;
    if (s === 'tenant' && !a.tenantId) return false;
    return a.permissions.has(p as Permission);
  });
}

export async function settingsRoutes(app: FastifyInstance, access: Access): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db: Db = app.deps.db;

  /** Выполняет операцию в БД-контексте, соответствующем уровню настройки, после проверки права. */
  async function withScope<T>(req: Parameters<typeof requireAuth>[0], def: SettingDefinition, scope: SettingScope, scopeIdIn: string | null | undefined, fn: (q: Queryable, target: SettingTarget) => Promise<T>): Promise<T> {
    const a = requireAuth(req);
    if (!def.scopes.includes(scope)) throw new AppError('bad_request', `Настройка «${def.title}» не может задаваться на уровне «${scope}»`);
    const needed = def.editPermission[scope];
    if (needed !== 'self' && !(needed && a.permissions.has(needed as Permission))) throw new AppError('forbidden', 'Недостаточно прав на изменение этой настройки');
    switch (scope) {
      case 'platform':
        return db.platform(a.userId, (q) => fn(q, { key: def.key, scope, scopeId: null, tenantId: null }));
      case 'tenant':
        if (!a.tenantId) throw new AppError('forbidden', 'Не выбран рабочий тенант');
        if (scopeIdIn && scopeIdIn !== a.tenantId) throw new AppError('forbidden', 'Можно менять настройки только своего тенанта');
        return db.tenant({ tenantId: a.tenantId, userId: a.userId }, (q) => fn(q, { key: def.key, scope, scopeId: a.tenantId, tenantId: a.tenantId }));
      case 'user':
        if (!a.tenantId) throw new AppError('forbidden', 'Не выбран рабочий тенант');
        if (scopeIdIn && scopeIdIn !== a.userId) throw new AppError('forbidden', 'Личные настройки можно менять только свои');
        return db.tenant({ tenantId: a.tenantId, userId: a.userId }, (q) => fn(q, { key: def.key, scope, scopeId: a.userId, tenantId: a.tenantId }));
      case 'source': {
        if (!scopeIdIn) throw new AppError('bad_request', 'Укажите идентификатор источника (scopeId)');
        return db.platform(a.userId, (q) => fn(q, { key: def.key, scope, scopeId: scopeIdIn, tenantId: null }));
      }
    }
  }

  r.get('/settings', {
    ...access.user(),
    schema: { querystring: z.object({ scope: z.enum(['platform']).optional() }) },
  }, async (req) => {
    const a = requireAuth(req);
    const canTenant = a.tenantId && a.permissions.has('tenant:settings_basic');
    const canPlatform = a.permissions.has('platform:settings');
    if (!canTenant && !canPlatform) throw new AppError('forbidden', 'Недостаточно прав');
    const platformView = req.query.scope === 'platform' || !a.tenantId;
    if (platformView && !canPlatform) throw new AppError('forbidden', 'Недостаточно прав');
    const ctx = platformView ? {} : { tenantId: a.tenantId, userId: a.userId };
    const rows = platformView
      ? await db.platform(a.userId, (q) => loadSettingRows(q), { readOnly: true })
      : await db.tenant({ tenantId: a.tenantId!, userId: a.userId }, (q) => loadSettingRows(q), { readOnly: true });
    const eff = new Map(effectiveSettings(rows, ctx).map((e) => [e.key, e]));
    const groups = new Map<string, unknown[]>();
    for (const def of listDefinitions()) {
      const e = eff.get(def.key)!;
      const editable = editableScopes(def, a).filter((s) => (platformView ? s === 'platform' : s !== 'platform' && s !== 'source'));
      if (!def.scopes.some((s) => (platformView ? s === 'platform' : s === 'tenant' || s === 'user'))) continue;
      (groups.get(def.group) ?? groups.set(def.group, []).get(def.group)!).push({
        key: def.key, title: def.title, description: def.description, ui: def.ui, scopes: def.scopes, editableScopes: editable,
        default: def.default, value: e.value, from: e.from, levels: e.levels, affectsBilling: def.affectsBilling ?? false, requiresRestart: def.requiresRestart ?? false,
      });
    }
    return { view: platformView ? 'platform' : 'tenant', groups: [...groups].map(([id, items]) => ({ id, title: GROUP_TITLES[id] ?? id, items })) };
  });

  r.put('/settings/:key', {
    ...access.user(),
    schema: {
      params: z.object({ key: z.string().min(3).max(120) }),
      body: z.object({ scope: scopeSchema, scopeId: z.string().uuid().nullish(), value: z.unknown(), expectedVersion: z.number().int().min(0).nullish(), reason: z.string().trim().max(300).nullish() }),
    },
  }, async (req) => {
    const def = requireDefinition(req.params.key);
    const { scope, scopeId, value, expectedVersion, reason } = req.body;
    const a = requireAuth(req);
    const res = await withScope(req, def, scope, scopeId, async (q, target) => {
      const before = (await loadSettingRows(q, [def.key])).find((s) => s.scope_type === scope && s.scope_id === target.scopeId)?.value ?? null;
      const out = await setSetting(q, target, value, { actorId: a.userId, reason, expectedVersion });
      await audit(q, req, { tenantId: scope === 'platform' || scope === 'source' ? null : a.tenantId, action: 'settings.updated', objectType: 'setting', objectId: def.key, before: { scope, value: before }, after: { scope, value, reason } });
      return out;
    });
    if (def.key.startsWith('auth.')) resetAuthCaches();
    return res;
  });

  r.delete('/settings/:key', {
    ...access.user(),
    schema: { params: z.object({ key: z.string().min(3).max(120) }), querystring: z.object({ scope: scopeSchema, scopeId: z.string().uuid().optional() }) },
  }, async (req) => {
    const def = requireDefinition(req.params.key);
    const a = requireAuth(req);
    const { scope, scopeId } = req.query;
    const cleared = await withScope(req, def, scope, scopeId, async (q, target) => {
      const ok = await clearSetting(q, target, { actorId: a.userId });
      if (ok) await audit(q, req, { tenantId: scope === 'platform' || scope === 'source' ? null : a.tenantId, action: 'settings.cleared', objectType: 'setting', objectId: def.key, before: { scope } });
      return ok;
    });
    if (def.key.startsWith('auth.')) resetAuthCaches();
    return { cleared };
  });

  r.get('/settings/:key/history', {
    ...access.user(),
    schema: { params: z.object({ key: z.string().min(3).max(120) }), querystring: z.object({ scope: scopeSchema, scopeId: z.string().uuid().optional() }) },
  }, async (req) => {
    const a = requireAuth(req);
    const def = requireDefinition(req.params.key);
    const { scope, scopeId } = req.query;
    if (!editableScopes(def, a).includes(scope)) throw new AppError('forbidden', 'Недостаточно прав');
    // права на уровень проверены выше; платформенный контекст — только для платформенных уровней
    const platformLevel = scope === 'platform' || scope === 'source';
    const target = scope === 'platform' ? null : scope === 'tenant' ? a.tenantId : scope === 'user' ? a.userId : (scopeId ?? null);
    const items = platformLevel
      ? await db.platform(a.userId, (q) => settingHistory(q, def.key, scope, target), { readOnly: true })
      : await db.tenant({ tenantId: a.tenantId!, userId: a.userId }, (q) => settingHistory(q, def.key, scope, target), { readOnly: true });
    return { items: items.map((h) => ({ id: h.id, version: h.version, oldValue: h.old_value, newValue: h.new_value, changedBy: h.changed_by, reason: h.reason, ts: h.ts })) };
  });

  r.post('/settings/history/:id/rollback', { ...access.user(), schema: { params: uuidParam } }, async (req) => {
    const a = requireAuth(req);
    type Hist = { key: string; scope_type: SettingScope; scope_id: string | null; tenant_id: string | null };
    const read = (q: Queryable) => q.query<Hist>('SELECT key, scope_type, scope_id, tenant_id FROM settings_history WHERE id = $1', [req.params.id]);
    // запись истории ищем только в доступной пользователю области (RLS); платформенный контекст — только при праве platform:settings
    let h = a.tenantId ? (await db.tenant({ tenantId: a.tenantId, userId: a.userId }, read, { readOnly: true })).rows[0] : undefined;
    if (!h && a.permissions.has('platform:settings')) h = (await db.platform(a.userId, read, { readOnly: true })).rows[0];
    if (!h) throw new AppError('not_found', 'Запись истории не найдена');
    const def = requireDefinition(h.key);
    const hist = h;
    await withScope(req, def, hist.scope_type, hist.scope_id, async (q) => {
      await rollbackSetting(q, req.params.id, { actorId: a.userId });
      await audit(q, req, { tenantId: hist.scope_type === 'platform' || hist.scope_type === 'source' ? null : a.tenantId, action: 'settings.rolled_back', objectType: 'setting', objectId: hist.key, after: { scope: hist.scope_type, historyId: req.params.id } });
    });
    if (hist.key.startsWith('auth.')) resetAuthCaches();
    return { status: 'ok' };
  });
}
