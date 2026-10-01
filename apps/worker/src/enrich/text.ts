/** Нижний регистр, «ё» → «е», токены — слова и числа (дефис внутри слова сохраняется). */
export const normalize = (s: string): string => s.toLowerCase().replace(/ё/g, 'е');

export const tokenize = (s: string): string[] =>
  normalize(s).match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
