-- 0005_feature_flag_function: прикладной роли API запрещена прямая запись в справочник feature_flags.
-- Изменение флага — через функцию с правами владельца, которая проверяет платформенный контекст.
CREATE OR REPLACE FUNCTION set_feature_flag(p_key text, p_enabled boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT app_is_platform_admin() THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;
  UPDATE feature_flags SET enabled = p_enabled, updated_at = now() WHERE key = p_key;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION set_feature_flag(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_feature_flag(text, boolean) TO app_api;

SELECT app_apply_grants();
