import { readFileSync } from 'node:fs';
import { REAL_ENTITIES } from '@mediaradar/db';
import { evaluate, formatReport, type GoldItem } from './eval';
import { rulesAnalyzer } from './rules';
import type { DictEntity } from './types';

/**
 * `pnpm --filter @mediaradar/worker nlp:eval` — качество разметчика на контрольных выборках, размеченных вручную:
 *  - gold.json (130 материалов) — на нём настраивались словари, поэтому цифры по нему оптимистичны;
 *  - gold-fresh.json (70 материалов) — другие материалы, словари по ним не настраивались: это честная оценка.
 */
const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8')) as GoldItem[];
const tuned = load('gold.json');
const fresh = load('gold-fresh.json');
const dictionary: DictEntity[] = REAL_ENTITIES.map((e) => ({
  type: e.type,
  name: e.name,
  aliases: e.aliases,
}));
for (const [title, items] of [
  ['Выборка, на которой настраивались словари', tuned],
  ['Чистая проверка (словари по ней не настраивались)', fresh],
] as const)
  console.log(formatReport(title, await evaluate([...items], rulesAnalyzer, dictionary)) + '\n');
