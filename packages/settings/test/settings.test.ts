import { describe, expect, it } from 'vitest';
import {
  GROUP_TITLES,
  assertScopeAllowed,
  getDefinition,
  listDefinitions,
  parseSettingValue,
  requireDefinition,
  resolveSetting,
  type StoredSetting,
} from '../src';

describe('реестр', () => {
  const all = listDefinitions();
  it('ключи уникальны, у каждого есть группа с заголовком и описание', () => {
    expect(new Set(all.map((d) => d.key)).size).toBe(all.length);
    for (const d of all) {
      expect(GROUP_TITLES[d.group], d.key).toBeTruthy();
      expect(d.title.length, d.key).toBeGreaterThan(2);
      expect(d.description.length, d.key).toBeGreaterThan(5);
    }
  });
  it('значение по умолчанию проходит собственную схему; на каждом уровне есть право редактирования', () => {
    for (const d of all) {
      expect(d.schema.safeParse(d.default).success, d.key).toBe(true);
      for (const s of d.scopes) expect(d.editPermission[s], `${d.key}@${s}`).toBeTruthy();
    }
  });
  it('содержит ключи из PRODUCT_SPEC §10.2', () => {
    for (const k of [
      'content.policy.default.GOV_PORTAL',
      'content.policy.default.NEWS_SITE',
      'content.policy.default.TELEGRAM',
      'content.policy.override',
      'content.excerpt.maxChars',
      'backfill.defaultDepthDays',
      'backfill.maxDepthDays',
      'backfill.rps',
      'backfill.priority',
      'schedule.minIntervalSec',
      'schedule.maxIntervalSec',
      'schedule.adaptive.enabled',
      'fetch.respectRobots',
      'fetch.perHostRps',
      'fetch.userAgent',
      'nlp.pipeline.stages.ner.enabled',
      'ai.budget.monthlyTokens',
      'ai.budget.hardStop',
      'retention.rawHtmlDays',
      'retention.articleDays',
      'retention.aiCallLogDays',
      'moderation.mode',
      'alerts.dedupeWindowMin',
      'reports.auto.requireReview',
      'portal.public.enabled',
      'portal.public.showFullText',
      'discovery.territory.levels',
      'legal.profile',
      'ui.theme.default',
    ])
      expect(getDefinition(k), k).toBeDefined();
  });
  it('политики по умолчанию соответствуют решению владельца', () => {
    expect(getDefinition('content.policy.default.GOV_PORTAL')!.default).toBe('full');
    expect(getDefinition('content.policy.default.NEWS_SITE')!.default).toBe('excerpt');
    expect(getDefinition('backfill.defaultDepthDays')!.default).toBe(365);
    expect(getDefinition('moderation.mode')!.default).toBe('auto');
    expect(getDefinition('retention.rawHtmlDays')!.default).toBe(90);
    expect(getDefinition('retention.articleDays')!.default).toBeNull();
  });
});

describe('валидация', () => {
  it('отвергает значение вне диапазона с понятным сообщением', () => {
    const d = requireDefinition('backfill.defaultDepthDays');
    expect(() => parseSettingValue(d, 0)).toThrow(/Недопустимое значение/);
    expect(() => parseSettingValue(d, 'много')).toThrow();
    expect(parseSettingValue(d, 30)).toBe(30);
  });
  it('неизвестный ключ и недопустимый уровень', () => {
    expect(() => requireDefinition('no.such.key')).toThrow(/Неизвестная/);
    expect(() => assertScopeAllowed(requireDefinition('fetch.userAgent'), 'tenant')).toThrow(
      /не может задаваться/,
    );
    expect(() => assertScopeAllowed(requireDefinition('ui.theme.default'), 'user')).not.toThrow();
  });
});

describe('разрешение значения по уровням', () => {
  const d = requireDefinition('backfill.defaultDepthDays');
  const T = 't-1';
  const S = 's-1';
  const rows: StoredSetting[] = [
    { scope_type: 'platform', scope_id: null, value: 180 },
    { scope_type: 'tenant', scope_id: T, value: 90 },
    { scope_type: 'tenant', scope_id: 't-other', value: 7 },
    { scope_type: 'source', scope_id: S, value: 30 },
  ];
  it('по умолчанию', () => expect(resolveSetting(d, [], {})).toEqual({ value: 365, from: 'default' }));
  it('платформа', () => expect(resolveSetting(d, rows, {})).toEqual({ value: 180, from: 'platform' }));
  it('тенант перекрывает платформу и не видит чужих значений', () =>
    expect(resolveSetting(d, rows, { tenantId: T })).toEqual({ value: 90, from: 'tenant' }));
  it('источник — самый специфичный', () =>
    expect(resolveSetting(d, rows, { tenantId: T, sourceId: S })).toEqual({ value: 30, from: 'source' }));
  it('источник другого тенанта/без контекста не применяется', () =>
    expect(resolveSetting(d, rows, { tenantId: T, sourceId: 's-2' })).toEqual({ value: 90, from: 'tenant' }));
  it('значения на недопустимом для ключа уровне игнорируются', () => {
    const ua = requireDefinition('fetch.userAgent');
    expect(
      resolveSetting(ua, [{ scope_type: 'tenant', scope_id: T, value: 'evil' }], { tenantId: T }).from,
    ).toBe('default');
  });
});
