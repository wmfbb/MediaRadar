import { describe, expect, it } from 'vitest';
import { slugify } from '../src/lib/slug';

describe('slugify', () => {
  it('транслитерирует и чистит', () => {
    expect(slugify('Алтайский край')).toBe('altayskiy-kray');
    expect(slugify('  Мой  Регион!! 2027 ')).toBe('moy-region-2027');
    expect(slugify('Я')).toMatch(/^ws-/);
    expect(slugify('A'.repeat(100)).length).toBeLessThanOrEqual(40);
    expect(slugify('Тест')).toMatch(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/);
  });
});
