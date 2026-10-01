/** Минимум суток обычной активности, чтобы было с чем сравнивать. */
const MIN_BASELINE_DAYS = 3;
/** Окно сравнения: «обычный» уровень — медиана предыдущих суток, но не больше этого числа. */
const BASELINE_WINDOW = 7;
/** Всплеск — не меньше чем в 2 раза выше обычного и не меньше чем на 10 материалов (мелочь всплеском не считается). */
const RATIO = 2;
const MIN_EXTRA = 10;

export interface Spike {
  /** Индекс суток в исходном ряду. */
  index: number;
  count: number;
  /** Обычный уровень (медиана предыдущих суток). */
  baseline: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Ищет сутки с аномально большим числом публикаций.
 * `reliableFrom` — первый индекс, начиная с которого ряд полный (до начала сбора лента источника отдаёт лишь последние записи,
 * поэтому ранние сутки занижены, и их нельзя считать «обычным» уровнем); `until` — первый индекс, который не оцениваем
 * (текущие сутки ещё не закончились).
 */
export function detectSpikes(counts: number[], reliableFrom: number, until: number): Spike[] {
  const out: Spike[] = [];
  for (let i = Math.max(reliableFrom + MIN_BASELINE_DAYS, 0); i < Math.min(until, counts.length); i++) {
    const baseline = median(counts.slice(Math.max(reliableFrom, i - BASELINE_WINDOW), i));
    if (counts[i]! >= baseline * RATIO && counts[i]! - baseline >= MIN_EXTRA)
      out.push({ index: i, count: counts[i]!, baseline: Math.round(baseline) });
  }
  return out;
}
