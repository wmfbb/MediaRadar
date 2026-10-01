import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REAL_ENTITIES } from '@mediaradar/db';
import { evaluate, type GoldItem } from '../src/enrich/eval';
import { rulesAnalyzer } from '../src/enrich/rules';

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as GoldItem[];
const dictionary = REAL_ENTITIES.map((e) => ({ type: e.type, name: e.name, aliases: e.aliases }));

/**
 * Защита от «тихого ухудшения»: правки словарей не должны ронять качество на размеченных вручную выборках.
 * Пороги чуть ниже измеренных значений (см. docs/DEVELOPMENT.md §5а); это не цель качества, а нижняя граница.
 */
describe('качество разметки на контрольных выборках', () => {
  it('выборка, на которой настраивались словари (130)', async () => {
    const r = await evaluate(load('gold.json'), rulesAnalyzer, dictionary);
    expect(r.n).toBe(130);
    expect(r.topicAccuracy).toBeGreaterThanOrEqual(0.8);
    expect(r.sentimentAccuracy).toBeGreaterThanOrEqual(0.55);
    expect(r.sentimentWithinOne).toBeGreaterThanOrEqual(0.95);
    expect(r.sentiment3MacroF1).toBeGreaterThanOrEqual(0.68);
    expect(r.persons.f1).toBeGreaterThanOrEqual(0.9);
    expect(r.orgs.f1).toBeGreaterThanOrEqual(0.9);
  });
  it('чистая выборка (70), словари по ней не настраивались', async () => {
    const r = await evaluate(load('gold-fresh.json'), rulesAnalyzer, dictionary);
    expect(r.n).toBe(70);
    expect(r.topicAccuracy).toBeGreaterThanOrEqual(0.55);
    expect(r.sentimentAccuracy).toBeGreaterThanOrEqual(0.5);
    expect(r.sentimentWithinOne).toBeGreaterThanOrEqual(0.93);
    expect(r.sentiment3MacroF1).toBeGreaterThanOrEqual(0.58);
    expect(r.orgs.f1).toBeGreaterThanOrEqual(0.9);
  });
});
