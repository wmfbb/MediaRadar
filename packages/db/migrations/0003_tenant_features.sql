-- 0003_tenant_features: слой тенанта — алерты, отчёты, тарифы и подписки, платежи, фильтры, уведомления.

CREATE TABLE alert_rules (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  level       text NOT NULL CHECK (level IN ('high', 'mid', 'low')),
  keywords    text[] NOT NULL DEFAULT '{}',
  scope_labels text[] NOT NULL DEFAULT '{}',
  channels    text[] NOT NULL DEFAULT '{}',
  enabled     boolean NOT NULL DEFAULT true,
  fired_count integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER alert_rules_touch BEFORE UPDATE ON alert_rules FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
SELECT app_rls_tenant_table('alert_rules');

CREATE TABLE report_templates (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,   -- NULL = системный шаблон
  key         text NOT NULL,
  name        text NOT NULL,
  description text,
  icon        text,
  color       text,
  blocks      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX report_templates_key ON report_templates (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key);
SELECT app_rls_tenant_table('report_templates', true);

CREATE TABLE report_runs (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id uuid REFERENCES report_templates(id) ON DELETE SET NULL,
  name        text NOT NULL,
  type        text NOT NULL,
  period_from date NOT NULL,
  period_to   date NOT NULL,
  status      text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  format      text CHECK (format IN ('pdf', 'xlsx', 'pptx', 'csv', 'html')),
  size_bytes  integer,
  error       text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
SELECT app_rls_tenant_table('report_runs');

CREATE TABLE plans (
  key          text PRIMARY KEY,
  name         text NOT NULL,
  price_minor  integer,                 -- NULL = «по запросу»
  currency     text NOT NULL DEFAULT 'RUB',
  interval     text NOT NULL DEFAULT 'month',
  description  text,
  features     text[] NOT NULL DEFAULT '{}',
  entitlements jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort         integer NOT NULL DEFAULT 0,
  is_public    boolean NOT NULL DEFAULT true
);

CREATE TABLE subscriptions (
  tenant_id    uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan_key     text NOT NULL REFERENCES plans(key),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('trial', 'active', 'past_due', 'grace', 'suspended', 'canceled')),
  period_start timestamptz NOT NULL DEFAULT now(),
  period_end   timestamptz,
  trial_end    timestamptz,
  cancel_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER subscriptions_touch BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
SELECT app_rls_tenant_table('subscriptions');

CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider     text NOT NULL DEFAULT 'test',
  description  text NOT NULL,
  method_label text,
  amount_minor integer NOT NULL CHECK (amount_minor >= 0),
  currency     text NOT NULL DEFAULT 'RUB',
  status       text NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz
);
CREATE INDEX payments_tenant ON payments (tenant_id, created_at DESC);
SELECT app_rls_tenant_table('payments');

CREATE TABLE saved_filters (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  filter     jsonb NOT NULL,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'team')),
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT app_rls_tenant_table('saved_filters');

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,   -- NULL = всем в тенанте
  level      text NOT NULL CHECK (level IN ('crit', 'warn', 'info')),
  title      text NOT NULL,
  body       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX notifications_tenant ON notifications (tenant_id, created_at DESC);
SELECT app_rls_tenant_table('notifications');

SELECT app_apply_grants();
