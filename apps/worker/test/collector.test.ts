import { describe, expect, it } from 'vitest';
import { parseFeed } from '../src/collector/feed';
import { decodeBody } from '../src/collector/http';
import { extractArticle, extractListLinks } from '../src/collector/html';
import { canonicalUrl, contentHash, htmlToText, makeLead, parseDate } from '../src/collector/normalize';
import { cronToMinutes, nextRunAt } from '../src/collector/schedule';
import { judge } from '../src/collector/verify';

const NOW = new Date('2026-10-01T06:00:00Z');

describe('canonicalUrl', () => {
  it('приводит адреса к общему виду: https, без www, якоря, меток и хвостового слэша', () => {
    expect(canonicalUrl('http://www.Example.ru/news/123/?utm_source=x&b=2&a=1#top')).toBe(
      'https://example.ru/news/123?a=1&b=2',
    );
    expect(canonicalUrl('https://example.ru/')).toBe('https://example.ru/');
    expect(canonicalUrl('https://example.ru//a//b/')).toBe('https://example.ru/a/b');
  });
  it('отбрасывает не-http адреса и мусор', () => {
    expect(canonicalUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalUrl('not a url')).toBeNull();
  });
});

describe('очистка текста', () => {
  it('htmlToText убирает теги и скрипты, декодирует сущности', () => {
    expect(htmlToText('<p>Привет,&nbsp;<b>мир</b>!</p><script>x()</script>')).toBe('Привет, мир!');
  });
  it('makeLead режет по границе предложения или слова и добавляет многоточие только при обрезке по слову', () => {
    const short = 'Короткий текст.';
    expect(makeLead(short)).toBe(short);
    const sentences = 'Первое предложение достаточно длинное для проверки. '.repeat(10);
    expect(makeLead(sentences, 200)!.endsWith('.')).toBe(true);
    expect(makeLead('слово '.repeat(100), 100)!.endsWith('…')).toBe(true);
    expect(makeLead('   ')).toBeNull();
  });
  it('contentHash не зависит от регистра и пробелов', () => {
    expect(contentHash('Заголовок  Новости', 'Лид')).toBe(contentHash('заголовок новости', 'лид'));
  });
});

describe('parseDate', () => {
  it('понимает RFC 822 (в т.ч. двузначный год), ISO и даты без часового пояса (местное время +07:00)', () => {
    expect(parseDate('Thu, 01 Oct 2026 12:47:00 +0700', NOW)?.toISOString()).toBe('2026-10-01T05:47:00.000Z');
    expect(parseDate('Thu, 01 Oct 26 12:47:00 +0700', NOW)?.toISOString()).toBe('2026-10-01T05:47:00.000Z');
    expect(parseDate('2026-10-01T05:00:00Z', NOW)?.toISOString()).toBe('2026-10-01T05:00:00.000Z');
    expect(parseDate('2026-10-01 12:00:00', NOW)?.toISOString()).toBe('2026-10-01T05:00:00.000Z');
  });
  it('подрезает небольшое «будущее», отбрасывает явную ошибку и мусор', () => {
    expect(parseDate('2026-10-01T07:00:00Z', NOW)?.toISOString()).toBe(NOW.toISOString());
    expect(parseDate('2027-01-01T00:00:00Z', NOW)).toBeNull();
    expect(parseDate('вчера', NOW)).toBeNull();
    expect(parseDate(null, NOW)).toBeNull();
  });
});

describe('parseFeed', () => {
  it('RSS 2.0: CDATA, картинка из enclosure и из описания, автор', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/"><channel>
      <item><title><![CDATA[В Барнауле открыли «мост»]]></title><link>https://site.ru/news/1/</link>
        <description><![CDATA[<p>Лид <b>новости</b></p><img src="/img/a.jpg">]]></description><pubDate>Thu, 01 Oct 2026 12:47:00 +0700</pubDate><dc:creator>Иван</dc:creator>
        <enclosure url="https://site.ru/e.png" type="image/png" length="1"/></item>
      <item><title>Без картинки в ленте</title><link>/news/2</link><description>&lt;img src="/img/b.jpg"&gt; текст</description></item>
      <item><title></title><link>https://site.ru/news/3</link></item>
    </channel></rss>`;
    const items = parseFeed(xml, 'https://site.ru/rss.xml');
    expect(items).toHaveLength(2); // третий без заголовка отброшен
    expect(items[0]).toMatchObject({
      url: 'https://site.ru/news/1/',
      title: 'В Барнауле открыли «мост»',
      author: 'Иван',
      imageUrl: 'https://site.ru/e.png',
    });
    expect(htmlToText(items[0]!.description)).toBe('Лид новости');
    expect(items[1]!.url).toBe('https://site.ru/news/2');
    expect(items[1]!.imageUrl).toBe('https://site.ru/img/b.jpg');
  });
  it('Atom: выбирает ссылку rel=alternate, берёт published/updated', () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Запись</title>
      <link rel="self" href="https://x.ru/self"/><link rel="alternate" href="https://x.ru/a/1"/>
      <updated>2026-10-01T05:00:00Z</updated><summary>Кратко</summary><author><name>Анна</name></author></entry></feed>`;
    const [it] = parseFeed(xml, 'https://x.ru/feed');
    expect(it).toMatchObject({
      url: 'https://x.ru/a/1',
      title: 'Запись',
      publishedAt: '2026-10-01T05:00:00Z',
      author: 'Анна',
    });
  });
  it('RSS 1.0 (RDF)', () => {
    const xml = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <item><title>Заметка</title><link>https://r.ru/1</link><dc:date>2026-10-01T05:00:00Z</dc:date></item></rdf:RDF>`;
    expect(parseFeed(xml, 'https://r.ru/')).toHaveLength(1);
  });
  it('не-XML даёт пустой список, а не исключение', () => {
    expect(parseFeed('<html><body>403</body></html>', 'https://x.ru')).toEqual([]);
  });
});

describe('decodeBody', () => {
  it('читает windows-1251 по заголовку и по объявлению в XML', () => {
    const win1251 = Uint8Array.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // «Привет»
    expect(decodeBody(win1251, 'text/html; charset=windows-1251')).toBe('Привет');
    const xml = new TextEncoder().encode('<?xml version="1.0" encoding="utf-8"?><a>Ёлка</a>');
    expect(decodeBody(xml, 'application/xml')).toContain('Ёлка');
  });
});

describe('HTML: список и страница материала', () => {
  const list = `<html><body>
    <a href="/news/101">один</a><a href="https://www.site.ru/news/102?utm_x=1">два</a><a href="/news/101">повтор</a>
    <a href="/razdely/obshchestvo">раздел</a><a href="https://other.ru/news/103">чужой</a><a href="mailto:a@b.ru">почта</a></body></html>`;
  it('извлекает только ссылки своего сайта по шаблону, без повторов', () => {
    const links = extractListLinks(list, 'https://site.ru/', /^\/news\/\d+$/);
    expect(links).toEqual(['https://site.ru/news/101', 'https://www.site.ru/news/102?utm_x=1']);
  });
  it('метаданные: OpenGraph, JSON-LD и запасные варианты', () => {
    const og = `<html><head><meta property="og:title" content="Заголовок"><meta property="og:description" content="Описание"><meta property="og:image" content="/i.jpg">
      <meta property="article:published_time" content="2026-10-01T12:00:00+07:00"></head></html>`;
    expect(extractArticle(og, 'https://s.ru/n/1')).toEqual({
      title: 'Заголовок',
      description: 'Описание',
      publishedAt: '2026-10-01T12:00:00+07:00',
      imageUrl: 'https://s.ru/i.jpg',
      author: null,
    });
    const ld = `<html><head><title>Из title</title><script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","datePublished":"2026-09-30T10:00:00+07:00"}]}</script></head><body><h1> Из h1 </h1></body></html>`;
    const m = extractArticle(ld, 'https://s.ru/n/2');
    expect(m.title).toBe('Из h1');
    expect(m.publishedAt).toBe('2026-09-30T10:00:00+07:00');
    const time = `<html><body><article><h1>Т</h1><time datetime="2026-10-01T01:00:00Z">утром</time></article></body></html>`;
    expect(extractArticle(time, 'https://s.ru/n/3').publishedAt).toBe('2026-10-01T01:00:00Z');
  });
});

describe('расписание', () => {
  it('cronToMinutes понимает простые формы реестра', () => {
    expect(cronToMinutes('*/10 * * * *')).toBe(10);
    expect(cronToMinutes('* * * * *')).toBe(1);
    expect(cronToMinutes('0 * * * *')).toBe(60);
    expect(cronToMinutes('0 */6 * * *')).toBe(360);
    expect(cronToMinutes('30 7 * * *')).toBe(1440);
    expect(cronToMinutes('0 9 * * 1')).toBe(30);
    expect(cronToMinutes('мусор')).toBe(30);
  });
  it('при ошибках интервал растёт вдвое, но не более 16× и не дольше шести часов', () => {
    const last = new Date('2026-10-01T00:00:00Z');
    const mins = (errors: number) =>
      (nextRunAt(last, '*/10 * * * *', errors).getTime() - last.getTime()) / 60_000;
    expect(mins(0)).toBe(10);
    expect(mins(1)).toBe(20);
    expect(mins(3)).toBe(80);
    expect(mins(6)).toBe(160);
    expect(mins(30)).toBe(160); // 16×10
    const hourly = (errors: number) =>
      (nextRunAt(last, '0 * * * *', errors).getTime() - last.getTime()) / 60_000;
    expect(hourly(10)).toBe(360); // потолок 6 часов
  });
});

describe('judge: когда материал считается удалённым', () => {
  const url = 'https://s.ru/news/123';
  it('404, 410 и 451 — удалён', () => {
    for (const status of [404, 410, 451])
      expect(judge(url, { status, url, redirected: false })).toMatchObject({ kind: 'gone' });
  });
  it('редирект с глубокого адреса на главную — удалён', () => {
    expect(judge(url, { status: 200, url: 'https://s.ru/', redirected: true })).toEqual({
      kind: 'gone',
      reason: 'redirect_to_root',
    });
  });
  it('доступная страница и редирект на другой материал — не удалён', () => {
    expect(judge(url, { status: 200, url, redirected: false })).toEqual({ kind: 'alive' });
    expect(judge(url, { status: 200, url: 'https://s.ru/news/124', redirected: true })).toEqual({
      kind: 'alive',
    });
  });
  it('сбои сайта не считаются удалением', () => {
    for (const status of [403, 429, 500, 502, 503])
      expect(judge(url, { status, url, redirected: false }).kind).toBe('unknown');
  });
});

describe('русские даты и запасные источники данных', () => {
  const now = new Date('2026-10-01T08:00:00Z'); // 15:00 по Барнаулу
  it('parseDate/parseRuDate понимают текстовые даты сайтов (местное время)', () => {
    expect(parseDate('1 октября 2026 / 13:31', now)?.toISOString()).toBe('2026-10-01T06:31:00.000Z');
    expect(parseDate('01.10.2026 09:05', now)?.toISOString()).toBe('2026-10-01T02:05:00.000Z');
    expect(parseDate('сегодня, 12:00', now)?.toISOString()).toBe('2026-10-01T05:00:00.000Z');
    expect(parseDate('Вчера в 23:30', now)?.toISOString()).toBe('2026-09-30T16:30:00.000Z');
    expect(parseDate('скоро', now)).toBeNull();
  });
  it('«вчера» после полуночи по местному времени считается по местной дате', () => {
    const justAfterMidnightLocal = new Date('2026-09-30T18:10:00Z'); // 01:10 1 октября по Барнаулу
    expect(parseDate('вчера, 22:00', justAfterMidnightLocal)?.toISOString()).toBe('2026-09-30T15:00:00.000Z');
  });
  it('лид берётся из yandex:full-text, если description пуст', () => {
    const xml = `<rss xmlns:yandex="http://news.yandex.ru"><channel><item><title>Т</title><link>https://b.ru/1</link><description></description>
      <yandex:full-text>&lt;p&gt;Полный текст новости&lt;/p&gt;</yandex:full-text></item></channel></rss>`;
    expect(htmlToText(parseFeed(xml, 'https://b.ru/rss')[0]!.description)).toBe('Полный текст новости');
  });
  it('дата по селектору из настроек источника побеждает чужие <time> на странице', () => {
    const page = `<html><body><aside><time datetime="2026-10-01T14:00:00+07:00">программа передач</time></aside>
      <div class="d"><time>1 октября 2026 / 13:31</time></div><h1>Заголовок</h1></body></html>`;
    expect(extractArticle(page, 'https://k.ru/n/1', { dateSelector: '.d time' }).publishedAt).toBe(
      '1 октября 2026 / 13:31',
    );
    // без селектора <time> вне <article> не используется — лучше «неизвестно», чем неверно
    expect(extractArticle(page, 'https://k.ru/n/1').publishedAt).toBeNull();
  });
});
