import { describe, expect, it } from 'vitest';
import { detectSpikes } from '../src/lib/spikes';

describe('поиск всплесков публикаций', () => {
  const calm = [20, 22, 19, 21, 20, 23, 18];

  it('находит сутки, где публикаций вдвое больше обычного', () => {
    const s = detectSpikes([...calm, 60, 21], 0, 9);
    expect(s).toEqual([{ index: 7, count: 60, baseline: 20 }]);
  });

  it('обычные колебания и небольшие числа всплеском не считаются', () => {
    expect(detectSpikes([...calm, 31, 25], 0, 9)).toEqual([]); // в 1,5 раза — не всплеск
    expect(detectSpikes([2, 3, 2, 3, 2, 9], 0, 6)).toEqual([]); // в 3 раза, но всего на 6 материалов
  });

  it('ранние сутки до начала полного сбора не служат эталоном и сами не оцениваются', () => {
    // 2, 3, 22 — неполные сутки (сбор только начинался); с них нельзя судить, что 105 — всплеск
    const ramp = [2, 3, 22, 105, 56, 54, 139, 192];
    expect(detectSpikes(ramp, 8, 8)).toEqual([]);
    // после недели полного сбора сравнение начинается с первых трёх полных суток
    const full = [2, 3, 22, 100, 100, 100, 100, 260];
    expect(detectSpikes(full, 3, 8)).toEqual([{ index: 7, count: 260, baseline: 100 }]);
    expect(detectSpikes(full, 3, 7)).toEqual([]); // 7-е сутки ещё не оцениваем
  });

  it('текущие (незавершённые) сутки не оцениваются', () => {
    expect(detectSpikes([...calm, 60], 0, 7)).toEqual([]);
  });

  it('нужно хотя бы 3 полных суток для сравнения', () => {
    expect(detectSpikes([20, 20, 80], 0, 3)).toEqual([]);
  });
});
