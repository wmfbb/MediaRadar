import type pg from 'pg';
import { TOPIC_PRESET } from '@mediaradar/core';
import { TENANT_ROLE_META, TENANT_ROLE_PERMISSIONS } from '@mediaradar/rbac';
import { PLANS } from './plans';

export { PLANS } from './plans';

export const REPORT_TEMPLATES = [
  { key: 'mediametrics', name: 'Медиаметрия региона', description: 'Объём публикаций, охват, топ источников, динамика по темам', icon: '📊', color: '#3363ff' },
  { key: 'sentiment', name: 'Анализ тональности', description: 'Распределение и тренды настроений по секторам и гео', icon: '🎭', color: '#059669' },
  { key: 'persons', name: 'Карта упоминаний персон', description: 'NER-извлечение, частотность, контекст, связи', icon: '👤', color: '#8b5cf6' },
  { key: 'sources', name: 'Сравнение источников', description: 'Авторитетность, скорость, уникальность, доля негатива', icon: '⚖️', color: '#f59e0b' },
  { key: 'industry', name: 'Отраслевой дайджест', description: 'Агросектор / пищепром / ТЭК: сводка за период', icon: '🌾', color: '#e11d48' },
  { key: 'auto_review', name: 'Автообзор (AI)', description: 'Готовая статья-обзор, сгенерированная по собранным данным', icon: '✦', color: '#0f172a' },
];

export const FEATURE_FLAGS = [
  { key: 'portal.public', description: 'Публичный портал (SSR)', enabled: false },
  { key: 'ai.gateway', description: 'AI Gateway и NLP-конвейер', enabled: false },
  { key: 'billing.live', description: 'Реальные платежи (ЮKassa)', enabled: false },
];

/**
 * Справочные данные, одинаковые во всех окружениях (не демо): системные роли, тарифы, пресет тем,
 * системные шаблоны отчётов, флаги. Идемпотентно; роли и права синхронизируются с кодом (@mediaradar/rbac).
 */
export async function syncReferenceData(client: pg.Client): Promise<void> {
  await client.query('BEGIN');
  try {
    for (const [key, meta] of Object.entries(TENANT_ROLE_META)) {
      const r = await client.query<{ id: string }>(
        `INSERT INTO roles (tenant_id, key, name, description, is_system) VALUES (NULL, $1, $2, $3, true)
         ON CONFLICT (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
         DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description RETURNING id`,
        [key, meta.name, meta.description],
      );
      const roleId = r.rows[0]!.id;
      const perms = TENANT_ROLE_PERMISSIONS[key as keyof typeof TENANT_ROLE_PERMISSIONS];
      await client.query('DELETE FROM role_permissions WHERE role_id = $1 AND permission <> ALL($2::text[])', [roleId, perms]);
      await client.query(
        `INSERT INTO role_permissions (role_id, permission) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
        [roleId, perms],
      );
    }
    for (const p of PLANS) {
      await client.query(
        `INSERT INTO plans (key, name, price_minor, description, features, entitlements, sort)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, price_minor = EXCLUDED.price_minor,
           description = EXCLUDED.description, features = EXCLUDED.features, entitlements = EXCLUDED.entitlements, sort = EXCLUDED.sort`,
        [p.key, p.name, p.priceMinor, p.description, p.features, JSON.stringify(p.entitlements), p.sort],
      );
    }
    for (const [i, t] of TOPIC_PRESET.entries()) {
      await client.query(
        `INSERT INTO topics (tenant_id, key, name, color, sort) VALUES (NULL, $1, $2, $3, $4)
         ON CONFLICT (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
         DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color, sort = EXCLUDED.sort`,
        [t.key, t.name, t.color, i],
      );
    }
    for (const t of REPORT_TEMPLATES) {
      await client.query(
        `INSERT INTO report_templates (tenant_id, key, name, description, icon, color) VALUES (NULL, $1, $2, $3, $4, $5)
         ON CONFLICT (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
         DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, icon = EXCLUDED.icon, color = EXCLUDED.color`,
        [t.key, t.name, t.description, t.icon, t.color],
      );
    }
    for (const f of FEATURE_FLAGS) {
      await client.query(
        `INSERT INTO feature_flags (key, enabled, description) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description`,
        [f.key, f.enabled, f.description],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}
