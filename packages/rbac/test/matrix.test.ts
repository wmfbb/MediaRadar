import { describe, expect, it } from 'vitest';
import { TENANT_ROLE_KEYS, type TenantRoleKey } from '@mediaradar/core';
import {
  PLATFORM_ROLE_PERMISSIONS,
  TENANT_PERMISSIONS,
  TENANT_ROLE_PERMISSIONS,
  can,
  permissionsOf,
  requiresMfa,
} from '../src';

/**
 * Матрица из docs/PRODUCT_SPEC.md §8.2: ● полный, ◐ ограниченный, — нет.
 * Порядок колонок: OWNER, ADMIN, ANALYST, EDITOR, MODERATOR, VIEWER.
 * ● и ◐ означают «разрешение есть» (◐ дополнительно ограничивается в обработчике), — «разрешения нет».
 */
const ROLES: TenantRoleKey[] = ['OWNER', 'ADMIN', 'ANALYST', 'EDITOR', 'MODERATOR', 'VIEWER'];
const MATRIX: Array<[string, (typeof TENANT_PERMISSIONS)[number], string]> = [
  ['Лента и поиск', 'feed:read', '●●●●●●'],
  ['Личные фильтры', 'filter:manage_own', '●●●●●●'],
  ['Личные алерты', 'alert:manage_own', '●●●●●●'],
  ['Дашборды — просмотр', 'dashboard:read', '●●●●◐●'],
  ['Дашборды — личные', 'dashboard:build_own', '●●●——◐'],
  ['Дашборды — командные', 'dashboard:build_team', '●●●———'],
  ['Конструктор аналитики', 'analytics:build', '●●●———'],
  ['Экспорт данных', 'export:run', '●●●◐—◐'],
  ['Отчёты — просмотр', 'report:read', '●●●●●●'],
  ['Отчёты — создание', 'report:create', '●●●◐——'],
  ['Отчёты — расписание', 'report:schedule', '●●●———'],
  ['Автообзоры — публикация', 'report:publish_auto', '●●—●——'],
  ['Командные алерты', 'alert:manage_team', '●●●———'],
  ['Источники — просмотр', 'source:read', '●●●●●●'],
  ['Источники — предложить', 'source:propose', '●●◐———'],
  ['Приватные источники', 'source:manage_private', '●●————'],
  ['Модерация материалов', 'article:moderate', '●●—◐●—'],
  ['Рубрики и метки', 'article:edit_meta', '●●—●◐—'],
  ['Сущности', 'entity:edit', '●●◐●——'],
  ['Пользователи (просмотр)', 'user:read', '●●————'],
  ['Пользователи (управление)', 'user:manage', '●●————'],
  ['Роли', 'role:manage', '●●————'],
  ['Настройки тенанта — базовые', 'tenant:settings_basic', '●●————'],
  ['Настройки тенанта — полные', 'tenant:settings', '●—————'],
  ['Тариф и оплата', 'billing:manage', '●—————'],
  ['API-ключи', 'apikey:manage', '●●————'],
  ['Журнал аудита', 'audit:read', '●●————'],
];

describe('матрица ролей (PRODUCT_SPEC §8.2)', () => {
  for (const [title, perm, row] of MATRIX) {
    const cells = [...row];
    it(`${title} → ${perm}`, () => {
      expect(cells).toHaveLength(ROLES.length);
      ROLES.forEach((role, i) => {
        const expected = cells[i] !== '—';
        expect(can({ tenantRole: role, platformRole: null }, perm), `${role} × ${perm}`).toBe(expected);
      });
    });
  }

  it('все разрешения тенанта покрыты матрицей или общими правами', () => {
    const covered = new Set(MATRIX.map((m) => m[1]));
    const common = ['tenant:read', 'notification:read'];
    for (const p of TENANT_PERMISSIONS) expect(covered.has(p) || common.includes(p), p).toBe(true);
  });

  it('OWNER имеет все разрешения тенанта; ни одна роль не имеет платформенных', () => {
    expect(new Set(TENANT_ROLE_PERMISSIONS.OWNER)).toEqual(new Set(TENANT_PERMISSIONS));
    for (const r of TENANT_ROLE_KEYS)
      expect(
        [...permissionsOf({ tenantRole: r, platformRole: null })].some((p) => p.startsWith('platform:')),
      ).toBe(false);
  });

  it('иерархия: права VIEWER ⊂ ANALYST ⊂ ADMIN ⊂ OWNER (кроме модерации у EDITOR/MODERATOR)', () => {
    const subset = (a: TenantRoleKey, b: TenantRoleKey) =>
      TENANT_ROLE_PERMISSIONS[a].every((p) => TENANT_ROLE_PERMISSIONS[b].includes(p));
    expect(subset('VIEWER', 'ANALYST')).toBe(true);
    expect(subset('ANALYST', 'ADMIN')).toBe(true);
    expect(subset('ADMIN', 'OWNER')).toBe(true);
  });
});

describe('платформенные роли', () => {
  it('SUPPORT не управляет биллингом, DATA_STEWARD видит только источники', () => {
    expect(can({ tenantRole: null, platformRole: 'SUPPORT' }, 'platform:billing')).toBe(false);
    expect(can({ tenantRole: null, platformRole: 'SUPPORT' }, 'platform:impersonate')).toBe(true);
    expect(PLATFORM_ROLE_PERMISSIONS.DATA_STEWARD).toEqual(['platform:sources']);
    expect(can({ tenantRole: null, platformRole: 'BILLING_ADMIN' }, 'feed:read')).toBe(false);
  });
  it('2FA обязательна для OWNER/ADMIN и платформенных ролей', () => {
    expect(requiresMfa({ tenantRole: 'OWNER', platformRole: null })).toBe(true);
    expect(requiresMfa({ tenantRole: 'ADMIN', platformRole: null })).toBe(true);
    expect(requiresMfa({ tenantRole: 'ANALYST', platformRole: null })).toBe(false);
    expect(requiresMfa({ tenantRole: 'VIEWER', platformRole: 'SUPPORT' })).toBe(true);
  });
});
