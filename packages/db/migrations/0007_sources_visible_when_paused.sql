-- 0007: тенант должен видеть общий источник и после паузы своей подписки (иначе его нельзя возобновить).
-- Материалы приостановленных подписок по-прежнему скрыты (политика articles требует enabled).
DROP POLICY sources_select_api ON sources;
CREATE POLICY sources_select_api ON sources FOR SELECT TO app_api USING (
  owner_tenant_id = app_tenant() OR app_is_platform_admin()
  OR (owner_tenant_id IS NULL AND id IN (SELECT source_id FROM tenant_sources WHERE tenant_id = app_tenant())));

SELECT app_apply_grants();
