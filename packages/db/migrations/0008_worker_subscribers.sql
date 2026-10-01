-- 0008: воркеру для рассылки событий нужен список тенантов, подписанных на источник.
-- Таблица tenant_sources защищена RLS и для воркера, поэтому доступ даётся узкой функцией (принцип наименьших привилегий):
-- только идентификаторы тенантов с включённой подпиской, только для роли app_worker.
CREATE OR REPLACE FUNCTION worker_source_subscribers(p_source uuid) RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT tenant_id FROM tenant_sources WHERE source_id = p_source AND enabled
$$;
REVOKE ALL ON FUNCTION worker_source_subscribers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION worker_source_subscribers(uuid) TO app_worker;

SELECT app_apply_grants();
