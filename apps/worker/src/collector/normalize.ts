import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

const TRACKING = /^(utm_|yclid$|fbclid$|gclid$|ysclid$|_openstat$|from$|ref$|source$)/i;

/** Канонический адрес для сравнения: https, без www, без якоря и меток, без хвостового слэша. */
export function canonicalUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.port = '';
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  u.pathname = u.pathname.replace(/\/{2,}/g, '/');
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

export function htmlToText(html: string): string {
  if (!html) return '';
  const $ = cheerio.load(`<div>${html}</div>`);
  $('script,style').remove();
  return $.root()
    .text()
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanTitle(s: string): string {
  return htmlToText(s).slice(0, 500);
}

/** Короткий лид: до max символов, по возможности по границе предложения или слова. */
export function makeLead(text: string, max = 300): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence > max * 0.6) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(' ');
  return `${cut.slice(0, space > max * 0.6 ? space : max).replace(/[\s,;:—-]+$/, '')}…`;
}

const REGION_OFFSET = '+07:00'; // Алтайский край (Asia/Barnaul)
const REGION_OFFSET_MS = 7 * 3600_000;
const MONTHS: Record<string, number> = {
  января: 1,
  февраля: 2,
  марта: 3,
  апреля: 4,
  мая: 5,
  июня: 6,
  июля: 7,
  августа: 8,
  сентября: 9,
  октября: 10,
  ноября: 11,
  декабря: 12,
};
const pad = (n: number | string) => String(n).padStart(2, '0');

/** Даты, написанные по-русски: «1 октября 2026 / 13:31», «01.10.2026 13:31», «сегодня, 13:31», «вчера в 09:05». Время — местное. */
export function parseRuDate(raw: string, now = new Date()): Date | null {
  const s = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  let m =
    /(\d{1,2}) (января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря),? (\d{4})\D{0,5}(\d{1,2}):(\d{2})/.exec(
      s,
    );
  if (m)
    return parseDate(
      `${m[3]}-${pad(MONTHS[m[2]!]!)}-${pad(m[1]!)}T${pad(m[4]!)}:${m[5]}:00${REGION_OFFSET}`,
      now,
    );
  m = /(\d{1,2})\.(\d{2})\.(\d{4})\D{0,5}(\d{1,2}):(\d{2})/.exec(s);
  if (m) return parseDate(`${m[3]}-${m[2]}-${pad(m[1]!)}T${pad(m[4]!)}:${m[5]}:00${REGION_OFFSET}`, now);
  m = /(сегодня|вчера)\D{0,5}(\d{1,2}):(\d{2})/.exec(s);
  if (m) {
    const local = new Date(now.getTime() + REGION_OFFSET_MS - (m[1] === 'вчера' ? 86_400_000 : 0));
    const day = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
    return parseDate(`${day}T${pad(m[2]!)}:${m[3]}:00${REGION_OFFSET}`, now);
  }
  return null;
}

/**
 * Разбор даты публикации. Даты без часового пояса считаем местными (Алтайский край);
 * «будущие» даты более чем на сутки отбрасываем (ошибка сайта), небольшое опережение подрезаем до «сейчас».
 */
export function parseDate(raw: string | null | undefined, now = new Date()): Date | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  // русские и «точечные» даты разбираем сами: Date.parse читает 01.10.2026 как 10 января
  if (/[а-яё]/i.test(s) || /^\d{1,2}\.\d{2}\.\d{4}/.test(s)) return parseRuDate(s, now);
  s = s.replace(
    /^(\w{3},\s+\d{1,2}\s+\w{3})\s+(\d{2})(\s)/,
    (_, a: string, y: string, sp: string) => `${a} 20${y}${sp}`,
  );
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) s = `${s.replace(' ', 'T')}${REGION_OFFSET}`;
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = `${s}T00:00:00${REGION_OFFSET}`;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  if (t > now.getTime() + 24 * 3600_000) return null;
  return new Date(Math.min(t, now.getTime()));
}

export function contentHash(title: string, lead: string | null): string {
  return createHash('sha256')
    .update(`${title}\n${lead ?? ''}`.toLowerCase().replace(/\s+/g, ' ').trim())
    .digest('hex');
}
