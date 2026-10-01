import { compileDictionary, extractEntities } from './entities';
import { analyzeSentiment } from './sentiment';
import { analyzeTopic } from './topics';
import type { Analysis, AnalyzeInput, Analyzer, DictEntity } from './types';

/** Версия разметчика на правилах. Смена версии + `enrich --reset` перечитывает все материалы заново. */
export const RULES_METHOD = 'rules-1';

// Словарь компилируется один раз на набор записей: повторные вызовы с тем же массивом берут кэш.
const cache = new WeakMap<DictEntity[], ReturnType<typeof compileDictionary>>();
const compiled = (dict: DictEntity[]) =>
  cache.get(dict) ?? cache.set(dict, compileDictionary(dict)).get(dict)!;

export const rulesAnalyzer: Analyzer = {
  method: RULES_METHOD,
  analyze({ title, lead }: AnalyzeInput, dictionary: DictEntity[]): Analysis {
    return {
      topic: analyzeTopic(title, lead),
      sentiment: analyzeSentiment(title, lead),
      entities: extractEntities(lead ? `${title}. ${lead}` : title, compiled(dictionary)),
    };
  },
};

/** Реестр разметчиков: сюда добавляется нейросетевой (`llm`) на следующем шаге. */
export const ANALYZERS: Record<string, Analyzer> = { rules: rulesAnalyzer };
export const DEFAULT_ANALYZER = 'rules';
