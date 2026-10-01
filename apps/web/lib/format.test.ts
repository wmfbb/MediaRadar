import { describe, expect, it } from 'vitest';
import { bucketLabel, compact, cronLabel, money, pctDelta, sentimentScore, timeAgo } from './format';

describe('cronLabel', () => {
  it.each([
    ['* * * * *', 'каждую минуту'],
    ['*/10 * * * *', 'каждые 10 мин'],
    ['0 * * * *', 'каждый час'],
    ['0 */6 * * *', 'каждые 6 ч'],
    ['30 7 * * *', 'ежедневно в 07:30'],
    ['0 9 * * 1', '0 9 * * 1'],
    ['не cron', 'не cron'],
  ])('%s → %s', (cron, label) => expect(cronLabel(cron)).toBe(label));
});

describe('форматирование', () => {
  it('timeAgo выбирает единицу', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    expect(timeAgo('2026-10-01T11:59:30Z', now)).toBe('30 сек назад');
    expect(timeAgo('2026-10-01T11:15:00Z', now)).toBe('45 мин назад');
    expect(timeAgo('2026-10-01T09:00:00Z', now)).toBe('3 ч назад');
    expect(timeAgo('2026-09-28T12:00:00Z', now)).toBe('3 дн назад');
  });
  it('не показывает отрицательное время из-за расхождения часов', () => {
    expect(timeAgo('2026-10-01T12:00:05Z', Date.parse('2026-10-01T12:00:00Z'))).toBe('0 сек назад');
  });
  it('money: копейки → рубли, null → «по запросу»', () => {
    expect(money(1_990_000).replace(/\s/g, ' ')).toBe('19 900 ₽');
    expect(money(null)).toBe('по запросу');
  });
  it('compact', () => {
    expect(compact(950)).toBe('950');
    expect(compact(2_400_000)).toBe('2.4 млн');
    expect(compact(15_667)).toBe('16 тыс.');
  });
  it('sentimentScore и pctDelta используют типографский минус и запятую', () => {
    expect(sentimentScore(-0.5)).toBe('−0,50');
    expect(sentimentScore(0.07)).toBe('+0,07');
    expect(sentimentScore(null)).toBe('—');
    expect(pctDelta(48.56)).toBe('+48,6%');
    expect(pctDelta(-3)).toBe('−3,0%');
    expect(pctDelta(null)).toBeNull();
  });
  it('bucketLabel: часы и дни', () => {
    expect(bucketLabel('2026-10-01T14:00', true)).toBe('14:00');
    expect(bucketLabel('2026-10-01', false)).toMatch(/1\s+окт/);
  });
});
