-- 0006_search_prefix: русский стеммер Snowball не сводит все формы слова к одной основе
-- («урожая» → «урож», «урожаю» → «урожа»). Второй индекс без стемминга позволяет искать по префиксу основы
-- и повышает полноту; результаты объединяются с морфологическим поиском (см. buildArticleWhere).
ALTER TABLE articles ADD COLUMN search_simple tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(lead, ''))) STORED;
CREATE INDEX articles_search_simple ON articles USING gin (search_simple);

SELECT app_apply_grants();
