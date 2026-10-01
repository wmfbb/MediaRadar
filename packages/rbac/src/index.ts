import type { PlatformRoleKey, TenantRoleKey } from '@mediaradar/core';

/**
 * Разрешения — атомарные «ресурс:действие».
 * Знаком ◐ в PRODUCT_SPEC §8.2 помечены ограниченные права: они выдаются как отдельное
 * (более узкое) разрешение либо проверяются по владельцу объекта/области в обработчике.
 */
export const TENANT_PERMISSIONS = [
  'tenant:read',
  'notification:read',
  'feed:read',
  'filter:manage_own',
  'dashboard:read',
  'dashboard:build_own',
  'dashboard:build_team',
  'analytics:build',
  'export:run',
  'report:read',
  'report:create',
  'report:schedule',
  'report:publish_auto',
  'alert:manage_own',
  'alert:manage_team',
  'source:read',
  'source:propose',
  'source:manage_private',
  'article:moderate',
  'article:edit_meta',
  'entity:edit',
  'user:read',
  'user:manage',
  'role:manage',
  'tenant:settings_basic',
  'tenant:settings',
  'billing:manage',
  'apikey:manage',
  'audit:read',
] as const;
export type TenantPermission = (typeof TENANT_PERMISSIONS)[number];

export const PLATFORM_PERMISSIONS = [
  'platform:tenants',
  'platform:settings',
  'platform:flags',
  'platform:ai',
  'platform:sources',
  'platform:billing',
  'platform:impersonate',
  'platform:audit',
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

export type Permission = TenantPermission | PlatformPermission;

const VIEWER: TenantPermission[] = [
  'tenant:read', 'notification:read', 'feed:read', 'filter:manage_own', 'dashboard:read', 'dashboard:build_own',
  'export:run', 'report:read', 'alert:manage_own', 'source:read',
];

const MODERATOR: TenantPermission[] = [
  'tenant:read', 'notification:read', 'feed:read', 'filter:manage_own', 'dashboard:read', 'report:read',
  'alert:manage_own', 'source:read', 'article:moderate', 'article:edit_meta',
];

const EDITOR: TenantPermission[] = [
  'tenant:read', 'notification:read', 'feed:read', 'filter:manage_own', 'dashboard:read', 'export:run',
  'report:read', 'report:create', 'report:publish_auto', 'alert:manage_own', 'source:read', 'article:moderate',
  'article:edit_meta', 'entity:edit',
];

const ANALYST: TenantPermission[] = [
  'tenant:read', 'notification:read', 'feed:read', 'filter:manage_own', 'dashboard:read', 'dashboard:build_own',
  'dashboard:build_team', 'analytics:build', 'export:run', 'report:read', 'report:create', 'report:schedule',
  'alert:manage_own', 'alert:manage_team', 'source:read', 'source:propose', 'entity:edit',
];

const ADMIN: TenantPermission[] = [
  ...new Set<TenantPermission>([
    ...ANALYST, 'report:publish_auto', 'source:manage_private', 'article:moderate', 'article:edit_meta',
    'user:read', 'user:manage', 'role:manage', 'tenant:settings_basic', 'apikey:manage', 'audit:read',
  ]),
];

const OWNER: TenantPermission[] = [...TENANT_PERMISSIONS];

export const TENANT_ROLE_PERMISSIONS: Record<TenantRoleKey, readonly TenantPermission[]> = {
  OWNER, ADMIN, ANALYST, EDITOR, MODERATOR, VIEWER,
};

export const TENANT_ROLE_META: Record<TenantRoleKey, { name: string; description: string }> = {
  OWNER: { name: 'Владелец', description: 'Полный доступ к тенанту, включая тариф и оплату' },
  ADMIN: { name: 'Администратор', description: 'Источники, пользователи, роли, модерация, ключи API' },
  ANALYST: { name: 'Аналитик', description: 'Аналитика, дашборды, отчёты, экспорт, командные алерты' },
  EDITOR: { name: 'Редактор', description: 'Контент и рубрикация, правка материалов, автообзоры' },
  MODERATOR: { name: 'Модератор', description: 'Одобрение и отклонение материалов' },
  VIEWER: { name: 'Читатель', description: 'Лента, базовые фильтры, личные алерты' },
};

export const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRoleKey, readonly PlatformPermission[]> = {
  SUPER_ADMIN: [...PLATFORM_PERMISSIONS],
  DATA_STEWARD: ['platform:sources'],
  BILLING_ADMIN: ['platform:billing'],
  SUPPORT: ['platform:tenants', 'platform:impersonate', 'platform:audit'],
};

/** Роли, для которых включена обязательная 2FA (см. PRODUCT_SPEC §8.4). */
export const MFA_REQUIRED_TENANT_ROLES: readonly TenantRoleKey[] = ['OWNER', 'ADMIN'];

export interface Subject {
  userId: string;
  tenantId: string | null;
  tenantRole: TenantRoleKey | null;
  platformRole: PlatformRoleKey | null;
  /** Ограничения области (ABAC): доступ только к выбранным темам/территориям/группам источников. */
  scope: MembershipScope;
}

export interface MembershipScope {
  topics?: string[];
  geo?: string[];
  sourceGroups?: string[];
}

export function permissionsOf(subject: Pick<Subject, 'tenantRole' | 'platformRole'>): Set<Permission> {
  const out = new Set<Permission>();
  if (subject.tenantRole) for (const p of TENANT_ROLE_PERMISSIONS[subject.tenantRole]) out.add(p);
  if (subject.platformRole) for (const p of PLATFORM_ROLE_PERMISSIONS[subject.platformRole]) out.add(p);
  return out;
}

export const can = (subject: Pick<Subject, 'tenantRole' | 'platformRole'>, permission: Permission): boolean =>
  permissionsOf(subject).has(permission);

export const requiresMfa = (subject: Pick<Subject, 'tenantRole' | 'platformRole'>): boolean =>
  (subject.tenantRole !== null && MFA_REQUIRED_TENANT_ROLES.includes(subject.tenantRole)) ||
  subject.platformRole !== null;

export const isTenantPermission = (p: string): p is TenantPermission =>
  (TENANT_PERMISSIONS as readonly string[]).includes(p);
export const isPlatformPermission = (p: string): p is PlatformPermission =>
  (PLATFORM_PERMISSIONS as readonly string[]).includes(p);
