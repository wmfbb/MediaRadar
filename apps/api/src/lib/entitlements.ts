import { AppError } from '@mediaradar/core';
import type { Queryable } from '@mediaradar/db';

export type Entitlements = Record<string, number | boolean | null>;

export async function loadEntitlements(q: Queryable): Promise<{ planKey: string; planName: string; status: string; entitlements: Entitlements }> {
  const r = await q.query<{ plan_key: string; name: string; status: string; entitlements: Entitlements }>(
    'SELECT s.plan_key, p.name, s.status, p.entitlements FROM subscriptions s JOIN plans p ON p.key = s.plan_key LIMIT 1');
  const row = r.rows[0];
  if (!row) throw new AppError('forbidden', 'У тенанта нет активной подписки');
  return { planKey: row.plan_key, planName: row.name, status: row.status, entitlements: row.entitlements };
}

/** null в лимите = без ограничения. Ошибка содержит данные для предложения смены тарифа. */
export function assertWithinLimit(e: { planName: string; entitlements: Entitlements }, key: string, used: number, label: string): void {
  const limit = e.entitlements[key];
  if (limit === null) return;
  if (typeof limit !== 'number' || used >= limit)
    throw new AppError('forbidden', `Лимит тарифа ${e.planName} исчерпан: ${label} — ${used} из ${limit ?? 0}. Перейдите на другой тариф.`, { reason: 'plan_limit', entitlement: key, limit: limit ?? 0, used });
}

export function assertFeature(e: { planName: string; entitlements: Entitlements }, key: string, label: string): void {
  if (e.entitlements[key] !== true)
    throw new AppError('forbidden', `Функция «${label}» не входит в тариф ${e.planName}.`, { reason: 'plan_feature', entitlement: key });
}

export async function usageCounts(q: Queryable): Promise<Record<string, number>> {
  const r = await q.query<Record<string, number>>(`
    SELECT
      (SELECT count(*)::int FROM tenant_sources WHERE enabled) AS "sources.active",
      (SELECT count(*)::int FROM memberships WHERE status = 'active') AS "seats",
      (SELECT count(*)::int FROM alert_rules) AS "alerts.rules",
      (SELECT count(*)::int FROM report_runs WHERE created_at >= date_trunc('month', now())) AS "reports.per_month",
      (SELECT count(*)::int FROM articles WHERE status = 'published' AND published_at >= date_trunc('month', now())) AS "articles.delivered_per_month",
      0 AS "ai.tokens_per_month",
      0 AS "exports.per_month",
      0 AS "api.requests_per_month"`);
  return r.rows[0]!;
}
