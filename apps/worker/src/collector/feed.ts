import { XMLParser } from 'fast-xml-parser';
import * as cheerio from 'cheerio';

export interface RawItem {
  url: string;
  title: string;
  /** Описание как есть (может содержать HTML) — очищается при нормализации. */
  description: string;
  publishedAt: string | null;
  imageUrl: string | null;
  author: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

type Node = Record<string, unknown> | string | undefined;
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') return text((v as Record<string, unknown>)['#text']);
  return String(v);
};
const attr = (v: unknown, name: string): string =>
  v && typeof v === 'object' && !Array.isArray(v) ? text((v as Record<string, unknown>)[`@_${name}`]) : '';

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return '';
  }
}

function firstImage(html: string, base: string): string | null {
  if (!html) return null;
  const src = cheerio.load(`<div>${html}</div>`)('img[src]').first().attr('src');
  return src ? absolute(src, base) || null : null;
}

function itemUrl(it: Record<string, unknown>, base: string): string {
  const link = it.link;
  if (typeof link === 'string' && link) return absolute(link, base);
  // Atom: <link rel="alternate" href="..."/>, возможно несколько
  const links = arr(link as Node[]);
  const alt =
    links.find((l) => attr(l, 'rel') === 'alternate') ?? links.find((l) => !attr(l, 'rel')) ?? links[0];
  const href = attr(alt, 'href') || text(alt);
  if (href) return absolute(href, base);
  const guid = it.guid;
  const g = text(guid);
  if (g && /^https?:\/\//i.test(g)) return g;
  return '';
}

function itemImage(it: Record<string, unknown>, base: string, html: string): string | null {
  for (const e of arr(it.enclosure as Node[])) {
    const type = attr(e, 'type');
    const url = attr(e, 'url');
    if (url && (!type || type.startsWith('image/'))) return absolute(url, base) || null;
  }
  for (const key of ['media:content', 'media:thumbnail']) {
    for (const m of arr(it[key] as Node[])) {
      const url = attr(m, 'url');
      const medium = attr(m, 'medium');
      const type = attr(m, 'type');
      if (
        url &&
        (key === 'media:thumbnail' || medium === 'image' || type.startsWith('image/') || (!medium && !type))
      )
        return absolute(url, base) || null;
    }
  }
  return firstImage(html, base);
}

type Items = Array<Record<string, unknown>> | Record<string, unknown> | undefined;
interface FeedDoc {
  rss?: { channel?: { item?: Items } };
  feed?: { entry?: Items };
  'rdf:RDF'?: { item?: Items };
}

/** Разбор RSS 2.0, Atom и RSS 1.0 (RDF). Возвращает «сырые» элементы; очистка и нормализация — отдельно. */
export function parseFeed(xml: string, baseUrl: string): RawItem[] {
  const doc = parser.parse(xml.replace(/^\uFEFF/, '')) as FeedDoc;
  const items: Array<Record<string, unknown>> = [
    ...arr(doc?.rss?.channel?.item),
    ...arr(doc?.feed?.entry),
    ...arr(doc?.['rdf:RDF']?.item),
  ];
  const out: RawItem[] = [];
  for (const it of items) {
    const url = itemUrl(it, baseUrl);
    const title = text(it.title);
    if (!url || !title) continue;
    const html = text(it['content:encoded']) || text(it.description) || text(it.summary) || text(it.content);
    const description =
      text(it.description) ||
      text(it.summary) ||
      text(it['content:encoded']) ||
      text(it.content) ||
      text(it['yandex:full-text']);
    const author =
      text(it['dc:creator']) ||
      text((it.author as Record<string, unknown> | undefined)?.name) ||
      (typeof it.author === 'string' ? it.author : '');
    out.push({
      url,
      title,
      description,
      publishedAt: text(it.pubDate) || text(it.published) || text(it.updated) || text(it['dc:date']) || null,
      imageUrl: itemImage(it, baseUrl, html),
      author: author || null,
    });
  }
  return out;
}
