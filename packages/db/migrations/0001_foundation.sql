-- 0001_foundation: расширения, контекстные функции, идентичность, тенанты, роли, аудит, настройки.
-- Подход к изоляции: каждая таблица слоя тенанта защищена RLS по current_setting('app.tenant_id').
-- Прикладные роли БД (app_api, app_worker) создаёт раннер миграций; они не владельцы таблиц.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- UUIDv7: 48 бит времени в мс + случайные биты (версия 7, вариант 10). Совпадает по формату с uuidv7() в @mediaradar/core.
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid LANGUAGE sql VOLATILE AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
                PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid
$$;

-- Контекст запроса. Выставляется приложением в начале каждой транзакции (set_config(..., true)).
CREATE OR REPLACE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
-- Платформенный администратор: видит данные всех тенантов (выставляется только после проверки права platform:*).
CREATE OR REPLACE FUNCTION app_is_platform_admin() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('app.platform_admin', true), '') = 'on' $$;
-- Системный контекст: вход, регистрация, приглашения — операции до определения тенанта/пользователя.
CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('app.system', true), '') = 'on' $$;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- Стандартная политика для таблиц с колонкой tenant_id.
-- p_nullable = true: строки с tenant_id IS NULL — общие (системные), читаются всеми, пишутся только платформой.
CREATE OR REPLACE FUNCTION app_rls_tenant_table(p_table regclass, p_nullable boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE t text := p_table::text;
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS tenant_select ON %s', t);
  EXECUTE format('DROP POLICY IF EXISTS tenant_insert ON %s', t);
  EXECUTE format('DROP POLICY IF EXISTS tenant_update ON %s', t);
  EXECUTE format('DROP POLICY IF EXISTS tenant_delete ON %s', t);
  EXECUTE format($f$CREATE POLICY tenant_select ON %s FOR SELECT USING (%s tenant_id = app_tenant() OR app_is_platform_admin())$f$,
                 t, CASE WHEN p_nullable THEN 'tenant_id IS NULL OR' ELSE '' END);
  EXECUTE format($f$CREATE POLICY tenant_insert ON %s FOR INSERT WITH CHECK (tenant_id = app_tenant() OR app_is_platform_admin())$f$, t);
  EXECUTE format($f$CREATE POLICY tenant_update ON %s FOR UPDATE USING (tenant_id = app_tenant() OR app_is_platform_admin())
                    WITH CHECK (tenant_id = app_tenant() OR app_is_platform_admin())$f$, t);
  EXECUTE format($f$CREATE POLICY tenant_delete ON %s FOR DELETE USING (tenant_id = app_tenant() OR app_is_platform_admin())$f$, t);
END $$;

-- Права прикладных ролей. Вызывается в конце каждой миграции.
CREATE OR REPLACE FUNCTION app_apply_grants() RETURNS void LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  GRANT USAGE ON SCHEMA public TO app_api, app_worker;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_api, app_worker;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_api, app_worker;
  -- журналы только дописываются
  FOREACH r IN ARRAY ARRAY['audit_log', 'settings_history'] LOOP
    IF to_regclass(r) IS NOT NULL THEN EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM app_api, app_worker', r); END IF;
  END LOOP;
  -- справочники: API только читает
  FOREACH r IN ARRAY ARRAY['geo_places', 'plans', 'feature_flags', 'entities'] LOOP
    IF to_regclass(r) IS NOT NULL THEN EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I FROM app_api', r); END IF;
  END LOOP;
  REVOKE ALL ON schema_migrations FROM app_api, app_worker;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Тенанты
-- ---------------------------------------------------------------------------------------------
CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  cell_id       text NOT NULL DEFAULT 'ru-1',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  region_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  legal_profile text NOT NULL DEFAULT 'RU_152',
  branding      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tenants_touch BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Пользователи и сессии (глобальная идентичность; видимость ограничена политиками)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  email              citext NOT NULL UNIQUE,
  password_hash      text NOT NULL,
  display_name       text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  locale             text NOT NULL DEFAULT 'ru',
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'pending')),
  platform_role      text CHECK (platform_role IN ('SUPER_ADMIN', 'DATA_STEWARD', 'BILLING_ADMIN', 'SUPPORT')),
  totp_secret_enc    text,
  totp_enabled       boolean NOT NULL DEFAULT false,
  totp_last_counter  bigint,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE user_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_recovery_codes_user ON user_recovery_codes (user_id);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    uuid REFERENCES tenants(id) ON DELETE SET NULL,
  token_hash   text NOT NULL UNIQUE,
  mfa_verified boolean NOT NULL DEFAULT false,
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE password_resets (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------
-- Роли, права, членство
-- ---------------------------------------------------------------------------------------------
CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,   -- NULL = системная роль
  key         text NOT NULL,
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (is_system = (tenant_id IS NULL))
);
CREATE UNIQUE INDEX roles_key_uniq ON roles (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

CREATE TABLE role_permissions (
  role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission text NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES roles(id),
  scope      jsonb NOT NULL DEFAULT '{}'::jsonb,        -- ABAC: {topics:[], geo:[], sourceGroups:[]}
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);

CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       citext NOT NULL,
  role_id     uuid NOT NULL REFERENCES roles(id),
  token_hash  text NOT NULL UNIQUE,
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  key_prefix   text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  scopes       text[] NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------
-- Аудит (только дозапись)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  ts          timestamptz NOT NULL DEFAULT now(),
  tenant_id   uuid,   -- без FK: журнал неизменяем и переживает удаление тенанта
  actor_id    uuid,
  actor_type  text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system', 'api_key')),
  action      text NOT NULL,
  object_type text,
  object_id   text,
  before      jsonb,
  after       jsonb,
  ip          text,
  user_agent  text,
  request_id  text
);
CREATE INDEX audit_log_tenant_ts ON audit_log (tenant_id, ts DESC);
CREATE INDEX audit_log_action ON audit_log (action, ts DESC);

CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- ---------------------------------------------------------------------------------------------
-- Реестр настроек и флаги функций
-- ---------------------------------------------------------------------------------------------
CREATE TABLE settings (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  key        text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('platform', 'tenant', 'source', 'user')),
  scope_id   uuid,                                   -- NULL только для platform
  tenant_id  uuid REFERENCES tenants(id) ON DELETE CASCADE,   -- NULL = платформенное значение
  value      jsonb NOT NULL,
  version    integer NOT NULL DEFAULT 1,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope_type = 'platform') = (scope_id IS NULL))
);
CREATE UNIQUE INDEX settings_uniq ON settings (key, scope_type, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE settings_history (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  key        text NOT NULL,
  scope_type text NOT NULL,
  scope_id   uuid,
  tenant_id  uuid REFERENCES tenants(id) ON DELETE CASCADE,
  old_value  jsonb,
  new_value  jsonb,
  version    integer NOT NULL,
  changed_by uuid,
  reason     text,
  ts         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX settings_history_key ON settings_history (key, scope_type, scope_id, ts DESC);

CREATE TABLE feature_flags (
  key         text PRIMARY KEY,
  enabled     boolean NOT NULL DEFAULT false,
  rules       jsonb NOT NULL DEFAULT '{}'::jsonb,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
-- tenants
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY; ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_select ON tenants FOR SELECT USING (
  id = app_tenant() OR app_is_platform_admin() OR app_is_system()
  OR id IN (SELECT tenant_id FROM memberships WHERE user_id = app_user()));
CREATE POLICY tenants_insert ON tenants FOR INSERT WITH CHECK (app_is_system() OR app_is_platform_admin());
CREATE POLICY tenants_update ON tenants FOR UPDATE USING (id = app_tenant() OR app_is_platform_admin())
  WITH CHECK (id = app_tenant() OR app_is_platform_admin());
CREATE POLICY tenants_delete ON tenants FOR DELETE USING (app_is_platform_admin());

-- users: видны сам себе, участникам своего тенанта (через членство), платформе и системному контексту (вход)
ALTER TABLE users ENABLE ROW LEVEL SECURITY; ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_select ON users FOR SELECT USING (
  app_is_system() OR app_is_platform_admin() OR id = app_user()
  OR id IN (SELECT user_id FROM memberships WHERE tenant_id = app_tenant()));
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (app_is_system() OR app_is_platform_admin());
CREATE POLICY users_update ON users FOR UPDATE USING (app_is_system() OR app_is_platform_admin() OR id = app_user())
  WITH CHECK (app_is_system() OR app_is_platform_admin() OR id = app_user());
CREATE POLICY users_delete ON users FOR DELETE USING (app_is_platform_admin());

-- сессии, коды восстановления, сброс пароля: только владелец или системный контекст
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sessions', 'user_recovery_codes', 'password_resets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_or_system ON %I USING (user_id = app_user() OR app_is_system()) WITH CHECK (user_id = app_user() OR app_is_system())', t);
  END LOOP;
END $$;

-- roles: системные (tenant_id IS NULL) читают все; пишутся только роли своего тенанта
ALTER TABLE roles ENABLE ROW LEVEL SECURITY; ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_select ON roles FOR SELECT USING (
  tenant_id IS NULL OR tenant_id = app_tenant() OR app_is_platform_admin() OR app_is_system());
CREATE POLICY roles_insert ON roles FOR INSERT WITH CHECK (
  (tenant_id = app_tenant() AND NOT is_system) OR app_is_platform_admin());
CREATE POLICY roles_update ON roles FOR UPDATE USING ((tenant_id = app_tenant() AND NOT is_system) OR app_is_platform_admin())
  WITH CHECK ((tenant_id = app_tenant() AND NOT is_system) OR app_is_platform_admin());
CREATE POLICY roles_delete ON roles FOR DELETE USING ((tenant_id = app_tenant() AND NOT is_system) OR app_is_platform_admin());

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY; ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY rp_select ON role_permissions FOR SELECT USING (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_id));
CREATE POLICY rp_insert ON role_permissions FOR INSERT WITH CHECK (
  app_is_platform_admin() OR EXISTS (SELECT 1 FROM roles r WHERE r.id = role_id AND r.tenant_id = app_tenant() AND NOT r.is_system));
CREATE POLICY rp_delete ON role_permissions FOR DELETE USING (
  app_is_platform_admin() OR EXISTS (SELECT 1 FROM roles r WHERE r.id = role_id AND r.tenant_id = app_tenant() AND NOT r.is_system));

-- memberships: тенант видит своих участников; пользователь — свои членства (для списка «мои тенанты»)
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY; ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_select ON memberships FOR SELECT USING (
  tenant_id = app_tenant() OR user_id = app_user() OR app_is_platform_admin() OR app_is_system());
CREATE POLICY memberships_insert ON memberships FOR INSERT WITH CHECK (
  tenant_id = app_tenant() OR app_is_platform_admin() OR app_is_system());
CREATE POLICY memberships_update ON memberships FOR UPDATE USING (tenant_id = app_tenant() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_tenant() OR app_is_platform_admin());
CREATE POLICY memberships_delete ON memberships FOR DELETE USING (tenant_id = app_tenant() OR app_is_platform_admin());

-- invitations: тенант + системный контекст (принятие приглашения по токену)
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY; ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY inv_select ON invitations FOR SELECT USING (tenant_id = app_tenant() OR app_is_platform_admin() OR app_is_system());
CREATE POLICY inv_insert ON invitations FOR INSERT WITH CHECK (tenant_id = app_tenant() OR app_is_platform_admin());
CREATE POLICY inv_update ON invitations FOR UPDATE USING (tenant_id = app_tenant() OR app_is_platform_admin() OR app_is_system())
  WITH CHECK (tenant_id = app_tenant() OR app_is_platform_admin() OR app_is_system());
CREATE POLICY inv_delete ON invitations FOR DELETE USING (tenant_id = app_tenant() OR app_is_platform_admin());

SELECT app_rls_tenant_table('api_keys');

-- audit_log: тенант видит своё; запись — в свой тенант или без тенанта (системное/платформенное событие)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_select ON audit_log FOR SELECT USING (tenant_id = app_tenant() OR app_is_platform_admin());
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (
  tenant_id IS NULL OR tenant_id = app_tenant() OR app_is_platform_admin() OR app_is_system());

-- settings: платформенные значения (tenant_id IS NULL) читают все, пишет платформа; значения уровня user видит только владелец
ALTER TABLE settings ENABLE ROW LEVEL SECURITY; ALTER TABLE settings FORCE ROW LEVEL SECURITY;
CREATE POLICY settings_select ON settings FOR SELECT USING (
  app_is_platform_admin()
  OR ((tenant_id IS NULL OR tenant_id = app_tenant()) AND (scope_type <> 'user' OR scope_id = app_user())));
CREATE POLICY settings_insert ON settings FOR INSERT WITH CHECK (
  app_is_platform_admin() OR (tenant_id = app_tenant() AND (scope_type <> 'user' OR scope_id = app_user())));
CREATE POLICY settings_update ON settings FOR UPDATE USING (
  app_is_platform_admin() OR (tenant_id = app_tenant() AND (scope_type <> 'user' OR scope_id = app_user())))
  WITH CHECK (app_is_platform_admin() OR (tenant_id = app_tenant() AND (scope_type <> 'user' OR scope_id = app_user())));
CREATE POLICY settings_delete ON settings FOR DELETE USING (
  app_is_platform_admin() OR (tenant_id = app_tenant() AND (scope_type <> 'user' OR scope_id = app_user())));

ALTER TABLE settings_history ENABLE ROW LEVEL SECURITY; ALTER TABLE settings_history FORCE ROW LEVEL SECURITY;
CREATE POLICY sh_select ON settings_history FOR SELECT USING (
  app_is_platform_admin() OR tenant_id = app_tenant() OR tenant_id IS NULL);
CREATE POLICY sh_insert ON settings_history FOR INSERT WITH CHECK (
  app_is_platform_admin() OR tenant_id = app_tenant());

SELECT app_apply_grants();
