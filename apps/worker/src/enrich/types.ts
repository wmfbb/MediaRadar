import type { SentimentLabel } from '@mediaradar/core';

export interface AnalyzeInput {
  title: string;
  lead: string | null;
}

/** Сущность из словаря (таблица entities, attributes.dictionary = true). */
export interface DictEntity {
  type: 'person' | 'org';
  name: string;
  aliases: string[];
}

export interface EntityHit {
  type: 'person' | 'org';
  name: string;
  mentions: number;
  /** true — найдено по шаблону («ООО «…»»), а не по словарю: такие записи создаются при необходимости. */
  auto: boolean;
}

export interface Analysis {
  /** Ключ темы из пресета (agro, fuel, …) или null — «без темы». */
  topic: string | null;
  sentiment: { score: number; label: SentimentLabel };
  entities: EntityHit[];
}

/**
 * Разметчик материала. Сейчас единственная реализация — правила и словари (`rules`).
 * Подключение нейросети по ключу (путь «Б» из PLAN.md) — вторая реализация с тем же результатом `Analysis`:
 * остальной код (очередь, запись в БД, Live, интерфейс) менять не придётся.
 */
export interface Analyzer {
  /** Версия разметчика; записывается в articles.nlp_method. */
  readonly method: string;
  analyze(input: AnalyzeInput, dictionary: DictEntity[]): Analysis | Promise<Analysis>;
}
