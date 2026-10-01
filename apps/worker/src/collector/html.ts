import * as cheerio from 'cheerio';
import { canonicalUrl, htmlToText } from './normalize';

/** Ссылки на материалы со страницы-списка: тот же сайт, путь подходит под шаблон, без повторов, в порядке появления. */
export function extractListLinks(html: string, baseUrl: string, pattern: RegExp, limit = 60): string[] {
  const $ = cheerio.load(html);
  const baseHost = new URL(baseUrl).hostname.replace(/^www\./, '');
  const seen = new Set<string>();
  const out: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let u: URL;
    try {
      u = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (u.hostname.replace(/^www\./, '') !== baseHost) return;
    if (!pattern.test(u.pathname)) return;
    const key = canonicalUrl(u.toString());
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(u.toString());
  });
  return out.slice(0, limit);
}

export interface ArticleMeta {
  title: string;
  description: string;
  publishedAt: string | null;
  imageUrl: string | null;
  author: string | null;
}

function ldDatePublished(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = ldDatePublished(n);
      if (r) return r;
    }
    return null;
  }
  const o = node as Record<string, unknown>;
  if (typeof o.datePublished === 'string') return o.datePublished;
  return ldDatePublished(o['@graph']);
}

/** Метаданные страницы материала: OpenGraph, JSON-LD, микроразметка, запасные варианты (h1, <title>, <time>). */
export function extractArticle(
  html: string,
  pageUrl: string,
  opts: { dateSelector?: string } = {},
): ArticleMeta {
  const $ = cheerio.load(html);
  const meta = (...names: string[]) => {
    for (const n of names) {
      const v = $(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`).first().attr('content');
      if (v?.trim()) return v.trim();
    }
    return '';
  };
  let ldDate: string | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (ldDate) return;
    try {
      ldDate = ldDatePublished(JSON.parse($(el).text()));
    } catch {
      /* битая разметка — пропускаем */
    }
  });
  const title =
    meta('og:title', 'twitter:title') ||
    htmlToText($('h1').first().text()) ||
    htmlToText($('title').first().text());
  const description = meta('og:description', 'description', 'twitter:description');
  const image = meta('og:image', 'twitter:image');
  // Дата: явный селектор из настроек источника → метаданные → JSON-LD → <time> внутри <article> (по всей странице нельзя:
  // там бывают программа передач, виджеты и т.п.)
  const picked = opts.dateSelector ? $(opts.dateSelector).first() : null;
  const published =
    (picked && (picked.attr('datetime') || htmlToText(picked.text()))) ||
    meta('article:published_time', 'og:article:published_time', 'datePublished', 'pubdate') ||
    ldDate ||
    $('article time[datetime]').first().attr('datetime') ||
    null;
  const author = meta('author', 'article:author') || null;
  let imageUrl: string | null = null;
  if (image) {
    try {
      imageUrl = new URL(image, pageUrl).toString();
    } catch {
      imageUrl = null;
    }
  }
  return { title, description, publishedAt: published, imageUrl, author };
}
