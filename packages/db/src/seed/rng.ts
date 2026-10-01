/** Детерминированный ГПСЧ (mulberry32): одинаковый seed → одинаковые демо-данные. */
export function createRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min;
  const pick = <T>(arr: readonly T[]): T => arr[int(0, arr.length - 1)]!;
  const chance = (p: number) => next() < p;
  const weighted = <T>(items: ReadonlyArray<readonly [T, number]>): T => {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = next() * total;
    for (const [v, w] of items) {
      r -= w;
      if (r <= 0) return v;
    }
    return items[items.length - 1]![0];
  };
  return { next, int, pick, chance, weighted };
}
export type Rng = ReturnType<typeof createRng>;
