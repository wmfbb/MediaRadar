-- 0002_catalog_content: темы, территории, источники, материалы, сущности (общий слой контента).
-- Партиционирование articles по месяцам вводится в Фазе 1 вместе с реальным потоком (см. docs/DATA_MODEL.md).

CREATE TABLE topics (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id  uuid REFERENCES tenants(id) ON DELETE CASCADE,    -- NULL = системный пресет
  parent_id  uuid REFERENCES topics(id) ON DELETE CASCADE,
  key        text NOT NULL,
  name       text NOT NULL,
  color      text NOT NULL DEFAULT '#64748b',
  sort       integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX topics_key_uniq ON topics (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key);
SELECT app_rls_tenant_table('topics', true);

CREATE TABLE geo_places (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  parent_id  uuid REFERENCES geo_places(id) ON DELETE CASCADE,
  level      text NOT NULL CHECK (level IN ('country', 'region', 'city', 'district', 'settlement')),
  name       text NOT NULL,
  lat        double precision,
  lon        double precision,
  population integer,
  meta       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX geo_places_parent ON geo_places (parent_id);
CREATE UNIQUE INDEX geo_places_uniq ON geo_places (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), level, name);

CREATE TABLE sources (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  owner_tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,   -- NULL = общий источник каталога
  kind            text NOT NULL CHECK (kind IN ('GOV_PORTAL', 'NEWS_SITE', 'TELEGRAM', 'VK', 'FORUM', 'YOUTUBE')),
  name            text NOT NULL,
  url             text NOT NULL,
  domain          text NOT NULL,
  geo_id          uuid REFERENCES geo_places(id) ON DELETE SET NULL,
  topic_id        uuid REFERENCES topics(id) ON DELETE SET NULL,
  parser          text NOT NULL CHECK (parser IN ('PLAYWRIGHT', 'RSS', 'CHEERIO', 'TELEGRAM_BOT', 'VK_API', 'YOUTUBE_API')),
  cron            text NOT NULL DEFAULT '*/15 * * * *',
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error', 'needs_attention')),
  trust_score     smallint NOT NULL DEFAULT 50 CHECK (trust_score BETWEEN 0 AND 100),
  content_policy  text CHECK (content_policy IN ('full', 'excerpt', 'metadata')),   -- NULL = по настройкам
  items_count     integer NOT NULL DEFAULT 0,
  last_run_at     timestamptz,
  last_error      text,
  error_count     integer NOT NULL DEFAULT 0,
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sources_domain_uniq ON sources (coalesce(owner_tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(domain));
CREATE TRIGGER sources_touch BEFORE UPDATE ON sources FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE source_configs (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  source_id  uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  version    integer NOT NULL,
  config     jsonb NOT NULL,
  author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  note       text,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, version)
);

CREATE TABLE tenant_sources (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id  uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  enabled    boolean NOT NULL DEFAULT true,
  overrides  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_id)
);
SELECT app_rls_tenant_table('tenant_sources');

CREATE TABLE articles (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  source_id            uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  url                  text NOT NULL,
  canonical_url        text NOT NULL,
  title                text NOT NULL,
  lead                 text,
  published_at         timestamptz NOT NULL,
  fetched_at           timestamptz NOT NULL DEFAULT now(),
  language             text NOT NULL DEFAULT 'ru',
  author               text,
  image_url            text,
  content_hash         text,
  simhash              bigint,
  duplicate_of         uuid REFERENCES articles(id) ON DELETE SET NULL,
  status               text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden', 'pending')),
  visibility_tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,   -- NULL = общий; иначе приватный материал тенанта
  topic_id             uuid REFERENCES topics(id) ON DELETE SET NULL,
  geo_id               uuid REFERENCES geo_places(id) ON DELETE SET NULL,
  sentiment_label      text CHECK (sentiment_label IN ('VP', 'P', 'N', 'NG', 'VN')),
  sentiment_score      real CHECK (sentiment_score BETWEEN -1 AND 1),
  views                integer NOT NULL DEFAULT 0,
  search               tsvector GENERATED ALWAYS AS (to_tsvector('russian', coalesce(title, '') || ' ' || coalesce(lead, ''))) STORED,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, canonical_url)
);
CREATE INDEX articles_source_pub ON articles (source_id, published_at DESC);
CREATE INDEX articles_pub ON articles (published_at DESC);
CREATE INDEX articles_topic_pub ON articles (topic_id, published_at DESC);
CREATE INDEX articles_geo ON articles (geo_id);
CREATE INDEX articles_sentiment ON articles (sentiment_label, published_at DESC);
CREATE INDEX articles_visibility ON articles (visibility_tenant_id) WHERE visibility_tenant_id IS NOT NULL;
CREATE INDEX articles_search ON articles USING gin (search);
CREATE INDEX articles_title_trgm ON articles USING gin (title gin_trgm_ops);

CREATE TABLE article_texts (
  article_id uuid PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  body_text  text NOT NULL
);

CREATE TABLE entities (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  type             text NOT NULL CHECK (type IN ('person', 'org', 'place', 'event')),
  canonical_name   text NOT NULL,
  is_public_figure boolean NOT NULL DEFAULT true,
  attributes       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type, canonical_name)
);

CREATE TABLE article_entities (
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  entity_id  uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  mentions   smallint NOT NULL DEFAULT 1,
  PRIMARY KEY (article_id, entity_id)
);
CREATE INDEX article_entities_entity ON article_entities (entity_id);

-- ---------------------------------------------------------------------------------------------
-- RLS общего слоя контента
-- ---------------------------------------------------------------------------------------------
-- geo_places, entities: справочники только для чтения прикладной ролью API (права отозваны в app_apply_grants).

ALTER TABLE sources ENABLE ROW LEVEL SECURITY; ALTER TABLE sources FORCE ROW LEVEL SECURITY;
CREATE POLICY sources_select_api ON sources FOR SELECT TO app_api USING (
  owner_tenant_id = app_tenant() OR app_is_platform_admin()
  OR (owner_tenant_id IS NULL AND id IN (SELECT source_id FROM tenant_sources WHERE tenant_id = app_tenant() AND enabled)));
CREATE POLICY sources_insert_api ON sources FOR INSERT TO app_api WITH CHECK (owner_tenant_id = app_tenant() OR app_is_platform_admin());
CREATE POLICY sources_update_api ON sources FOR UPDATE TO app_api USING (owner_tenant_id = app_tenant() OR app_is_platform_admin())
  WITH CHECK (owner_tenant_id = app_tenant() OR app_is_platform_admin());
CREATE POLICY sources_delete_api ON sources FOR DELETE TO app_api USING (owner_tenant_id = app_tenant() OR app_is_platform_admin());
CREATE POLICY sources_worker ON sources FOR ALL TO app_worker USING (true) WITH CHECK (true);

ALTER TABLE source_configs ENABLE ROW LEVEL SECURITY; ALTER TABLE source_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY sc_select_api ON source_configs FOR SELECT TO app_api USING (EXISTS (SELECT 1 FROM sources s WHERE s.id = source_id));
CREATE POLICY sc_write_api ON source_configs FOR ALL TO app_api USING (
  EXISTS (SELECT 1 FROM sources s WHERE s.id = source_id AND (s.owner_tenant_id = app_tenant() OR app_is_platform_admin())))
  WITH CHECK (EXISTS (SELECT 1 FROM sources s WHERE s.id = source_id AND (s.owner_tenant_id = app_tenant() OR app_is_platform_admin())));
CREATE POLICY sc_worker ON source_configs FOR ALL TO app_worker USING (true) WITH CHECK (true);

ALTER TABLE articles ENABLE ROW LEVEL SECURITY; ALTER TABLE articles FORCE ROW LEVEL SECURITY;
CREATE POLICY articles_select_api ON articles FOR SELECT TO app_api USING (
  app_is_platform_admin()
  OR visibility_tenant_id = app_tenant()
  OR (visibility_tenant_id IS NULL AND source_id IN (SELECT source_id FROM tenant_sources WHERE tenant_id = app_tenant() AND enabled)));
CREATE POLICY articles_insert_api ON articles FOR INSERT TO app_api WITH CHECK (visibility_tenant_id = app_tenant() OR app_is_platform_admin());
CREATE POLICY articles_update_api ON articles FOR UPDATE TO app_api USING (visibility_tenant_id = app_tenant() OR app_is_platform_admin())
  WITH CHECK (visibility_tenant_id = app_tenant() OR app_is_platform_admin());
CREATE POLICY articles_delete_api ON articles FOR DELETE TO app_api USING (visibility_tenant_id = app_tenant() OR app_is_platform_admin());
CREATE POLICY articles_worker ON articles FOR ALL TO app_worker USING (true) WITH CHECK (true);

-- article_texts / article_entities наследуют видимость материала (подзапрос проходит через RLS articles)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['article_texts', 'article_entities'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY via_article_api ON %I FOR SELECT TO app_api USING (EXISTS (SELECT 1 FROM articles a WHERE a.id = article_id))', t);
    EXECUTE format('CREATE POLICY worker_all ON %I FOR ALL TO app_worker USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
-- приватные материалы тенанта пишет и API: только в свои материалы
CREATE POLICY via_article_write_api ON article_texts FOR ALL TO app_api
  USING (EXISTS (SELECT 1 FROM articles a WHERE a.id = article_id AND a.visibility_tenant_id = app_tenant()))
  WITH CHECK (EXISTS (SELECT 1 FROM articles a WHERE a.id = article_id AND a.visibility_tenant_id = app_tenant()));

SELECT app_apply_grants();
