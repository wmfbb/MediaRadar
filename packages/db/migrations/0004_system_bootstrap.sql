-- 0004_system_bootstrap: регистрация нового тенанта создаёт и подписку в системном контексте
-- (одна транзакция: пользователь + тенант + членство + подписка).
DROP POLICY tenant_insert ON subscriptions;
CREATE POLICY tenant_insert ON subscriptions FOR INSERT
  WITH CHECK (tenant_id = app_tenant() OR app_is_platform_admin() OR app_is_system());

SELECT app_apply_grants();
