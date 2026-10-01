import { SENTIMENT_KEYS, type SentimentLabel } from '@mediaradar/core';
import type { Analyzer, DictEntity } from './types';

/** Размеченный вручную материал контрольной выборки (test/fixtures/gold.json). */
export interface GoldItem {
  title: string;
  lead: string | null;
  topic: string | null;
  sentiment: SentimentLabel;
  persons: string[];
  orgs: string[];
}

export interface Prf {
  precision: number;
  recall: number;
  f1: number;
}

export interface EvalReport {
  n: number;
  topicAccuracy: number;
  /** Среди материалов, у которых разметчик назвал тему: доля верных. */
  topicPrecisionWhenAssigned: number;
  /** Доля материалов, которым тема назначена. */
  topicCoverage: number;
  sentimentAccuracy: number;
  /** Ошибка не больше чем на одну градацию. */
  sentimentWithinOne: number;
  /** macro-F1 по пяти градациям. */
  sentimentMacroF1: number;
  /** macro-F1 по трём группам: негатив (NG+VN) / нейтрально / позитив (P+VP). */
  sentiment3MacroF1: number;
  persons: Prf;
  orgs: Prf;
}

const ratio = (a: number, b: number) => (b === 0 ? 0 : a / b);
const prf = (tp: number, fp: number, fn: number): Prf => {
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return {
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
};
const macroF1 = (pairs: Array<[string, string]>, classes: string[]) => {
  const f1s = classes.map((c) => {
    const tp = pairs.filter(([g, p]) => g === c && p === c).length;
    const fp = pairs.filter(([g, p]) => g !== c && p === c).length;
    const fn = pairs.filter(([g, p]) => g === c && p !== c).length;
    return prf(tp, fp, fn).f1;
  });
  return f1s.reduce((a, b) => a + b, 0) / classes.length;
};
const group3 = (l: string) => (l === 'VN' || l === 'NG' ? 'neg' : l === 'VP' || l === 'P' ? 'pos' : 'neu');

export async function evaluate(
  gold: GoldItem[],
  analyzer: Analyzer,
  dictionary: DictEntity[],
): Promise<EvalReport> {
  let topicOk = 0;
  let assigned = 0;
  let assignedOk = 0;
  const sent: Array<[string, string]> = [];
  const count = { person: { tp: 0, fp: 0, fn: 0 }, org: { tp: 0, fp: 0, fn: 0 } };
  for (const g of gold) {
    const a = await analyzer.analyze({ title: g.title, lead: g.lead }, dictionary);
    if (a.topic === g.topic) topicOk++;
    if (a.topic) {
      assigned++;
      if (a.topic === g.topic) assignedOk++;
    }
    sent.push([g.sentiment, a.sentiment.label]);
    for (const type of ['person', 'org'] as const) {
      const want = new Set(type === 'person' ? g.persons : g.orgs);
      const got = new Set(a.entities.filter((e) => e.type === type).map((e) => e.name));
      for (const n of got) {
        if (want.has(n)) count[type].tp++;
        else count[type].fp++;
      }
      for (const n of want) if (!got.has(n)) count[type].fn++;
    }
  }
  const idx = (l: string) => SENTIMENT_KEYS.indexOf(l as SentimentLabel);
  return {
    n: gold.length,
    topicAccuracy: ratio(topicOk, gold.length),
    topicPrecisionWhenAssigned: ratio(assignedOk, assigned),
    topicCoverage: ratio(assigned, gold.length),
    sentimentAccuracy: ratio(sent.filter(([g, p]) => g === p).length, sent.length),
    sentimentWithinOne: ratio(sent.filter(([g, p]) => Math.abs(idx(g) - idx(p)) <= 1).length, sent.length),
    sentimentMacroF1: macroF1(sent, [...SENTIMENT_KEYS]),
    sentiment3MacroF1: macroF1(
      sent.map(([g, p]) => [group3(g), group3(p)]),
      ['neg', 'neu', 'pos'],
    ),
    persons: prf(count.person.tp, count.person.fp, count.person.fn),
    orgs: prf(count.org.tp, count.org.fp, count.org.fn),
  };
}

export const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
export function formatReport(title: string, r: EvalReport): string {
  return [
    `${title} (материалов: ${r.n})`,
    `  тема: точность ${pct(r.topicAccuracy)}, назначена ${pct(r.topicCoverage)} материалов, из назначенных верно ${pct(r.topicPrecisionWhenAssigned)}`,
    `  тональность (5 градаций): точность ${pct(r.sentimentAccuracy)}, ±1 градация ${pct(r.sentimentWithinOne)}, macro-F1 ${r.sentimentMacroF1.toFixed(2)}`,
    `  тональность (негатив / нейтрально / позитив): macro-F1 ${r.sentiment3MacroF1.toFixed(2)}`,
    `  персоны: точность ${pct(r.persons.precision)}, полнота ${pct(r.persons.recall)}, F1 ${r.persons.f1.toFixed(2)}`,
    `  организации: точность ${pct(r.orgs.precision)}, полнота ${pct(r.orgs.recall)}, F1 ${r.orgs.f1.toFixed(2)}`,
  ].join('\n');
}
