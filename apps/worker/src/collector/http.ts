import { lookup } from 'node:dns/promises';
import { assertPublicHttpUrl, isPrivateAddress } from '@mediaradar/core';

export const USER_AGENT = 'Mozilla/5.0 (compatible; MediaRadarBot/0.1; +https://github.com/wmfbb/MediaRadar)';

export class FetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface FetchOptions {
  method?: 'GET' | 'HEAD';
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface FetchResult {
  status: number;
  /** Адрес после всех перенаправлений. */
  url: string;
  redirected: boolean;
  contentType: string;
  body: string;
}

export type Fetcher = (url: string, opts?: FetchOptions) => Promise<FetchResult>;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Если запросы идут через прокси (облачная среда разработки), имена хостов разрешает прокси, а не мы. */
const viaProxy = () => Boolean(process.env.HTTPS_PROXY ?? process.env.https_proxy);

async function assertResolvesPublic(host: string): Promise<void> {
  if (viaProxy()) return;
  const addresses = await lookup(host, { all: true }).catch(() => {
    throw new FetchError(`Не удалось определить адрес сайта ${host}`);
  });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address)))
    throw new FetchError(`Адрес ${host} указывает на внутреннюю сеть — запрос заблокирован`);
}

function charsetOf(contentType: string, head: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  const fromDoc =
    /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  return (fromHeader ?? fromDoc ?? 'utf-8').toLowerCase();
}

export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  try {
    return new TextDecoder(charsetOf(contentType, head)).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new FetchError(`Ответ больше ${Math.round(maxBytes / 1024)} КБ — отменено`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Безопасная загрузка страницы: только публичные http(s)-адреса, проверка адреса после DNS на каждом переходе,
 * ограничения по времени, размеру и числу перенаправлений, честный User-Agent.
 */
export const safeFetch: Fetcher = async (rawUrl, opts = {}) => {
  const { method = 'GET', timeoutMs = 15_000, maxBytes = 3 * 1024 * 1024, maxRedirects = 5 } = opts;
  let url = assertPublicHttpUrl(rawUrl);
  let redirected = false;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertResolvesPublic(url.hostname);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'user-agent': USER_AGENT,
          accept:
            'text/html,application/xhtml+xml,application/xml,application/rss+xml,application/atom+xml;q=0.9,*/*;q=0.5',
          'accept-language': 'ru,en;q=0.5',
        },
      });
    } catch (e) {
      const err = e as Error;
      throw new FetchError(
        err.name === 'TimeoutError'
          ? 'Сайт не ответил за отведённое время'
          : `Сетевая ошибка: ${err.message}`,
      );
    }
    const location = res.headers.get('location');
    if (REDIRECTS.has(res.status) && location) {
      await res.body?.cancel();
      url = assertPublicHttpUrl(new URL(location, url).toString());
      redirected = true;
      continue;
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (method === 'HEAD') {
      await res.body?.cancel();
      return { status: res.status, url: url.toString(), redirected, contentType, body: '' };
    }
    const bytes = await readCapped(res, maxBytes);
    return {
      status: res.status,
      url: url.toString(),
      redirected,
      contentType,
      body: decodeBody(bytes, contentType),
    };
  }
  throw new FetchError('Слишком много перенаправлений');
};
