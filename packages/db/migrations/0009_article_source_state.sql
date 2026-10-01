-- 0009: состояние материала на стороне источника.
-- Запись у нас не удаляется никогда: если материал пропал с сайта, мы фиксируем факт — когда обнаружили и чем это доказано.
ALTER TABLE articles
  ADD COLUMN source_state     text NOT NULL DEFAULT 'available' CHECK (source_state IN ('available', 'removed')),
  ADD COLUMN removed_at       timestamptz,          -- когда впервые обнаружили удаление (сохраняется, даже если материал вернулся)
  ADD COLUMN restored_at      timestamptz,          -- когда материал снова стал доступен после удаления
  ADD COLUMN removal_evidence jsonb,                -- последняя проверка: код ответа, адрес после редиректов, время
  ADD COLUMN last_checked_at  timestamptz,
  ADD COLUMN check_count      integer NOT NULL DEFAULT 0,
  ADD COLUMN next_check_at    timestamptz;          -- NULL = проверки завершены

-- очередь проверок наличия: только материалы, у которых проверка ещё запланирована
CREATE INDEX articles_next_check ON articles (next_check_at) WHERE next_check_at IS NOT NULL;
CREATE INDEX articles_source_state ON articles (source_state) WHERE source_state <> 'available';

SELECT app_apply_grants();
