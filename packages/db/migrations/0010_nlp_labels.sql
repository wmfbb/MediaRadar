-- 0010: разметка материалов (тема, тональность, персоны/организации).
-- Сами поля topic_id / sentiment_* / article_entities уже есть; здесь — служебные: чем и когда размечено,
-- и «замок» ручной правки (вручную исправленные метки пересчёт не затирает).
ALTER TABLE articles
  ADD COLUMN nlp_method     text,                                  -- версия разметчика, например 'rules-1'; NULL = ещё не размечен
  ADD COLUMN nlp_at         timestamptz,
  ADD COLUMN labels_locked  boolean NOT NULL DEFAULT false;        -- true = тема и тональность исправлены вручную

-- очередь на разметку: материалы, которые ещё не размечены текущей версией (см. apps/worker/src/enrich)
CREATE INDEX articles_nlp_pending ON articles (published_at DESC) WHERE nlp_at IS NULL;

SELECT app_apply_grants();
