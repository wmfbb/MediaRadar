import { isIP } from 'node:net';
import { AppError } from '@mediaradar/core';

const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'metadata.google.internal']);

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
/** Разворачивает IPv6 в 8 шестнадцатеричных групп (учитывает «::» и хвост в виде IPv4). */
function expandIPv6(ip: string): number[] | null {
  let x = ip.toLowerCase().split('%')[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (v4) {
    const [a, b, c, d] = v4[1]!.split('.').map(Number) as [number, number, number, number];
    x = x.slice(0, -v4[1]!.length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, tail, ...rest] = x.split('::');
  if (rest.length) return null;
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const missing = 8 - h.length - t.length;
  if ((tail === undefined && missing !== 0) || missing < 0) return null;
  const groups = [...h, ...Array.from({ length: tail === undefined ? 0 : missing }, () => '0'), ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4From = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function ipv6Private(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return true; // не удалось разобрать — считаем небезопасным
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g7 === 1)) return true; // :: и ::1
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  const embeddedV4 =
    (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) || // ::ffff:a.b.c.d и ::a.b.c.d
    (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0); // NAT64 64:ff9b::/96
  if (embeddedV4) return ipv4Private(v4From(g6, g7));
  if (g0 === 0x2002) return ipv4Private(v4From(g1, g2)); // 6to4
  return false;
}

/** Является ли адрес частным/служебным (loopback, link-local, RFC1918, CGNAT, multicast, metadata). */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  return v === 4 ? ipv4Private(ip) : v === 6 ? ipv6Private(ip) : false;
}

/**
 * Первичная проверка URL источника (защита от SSRF): только http/https, без учётных данных,
 * не localhost и не частные IP-адреса. Проверка после DNS-резолва и на редиректах — в сборщике (Фаза 1).
 */
export function assertPublicHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError('validation_failed', 'Некорректный адрес', [{ path: 'url', message: 'Укажите полный адрес, например https://example.ru' }]);
  }
  const fail = (message: string): never => {
    throw new AppError('validation_failed', message, [{ path: 'url', message }]);
  };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail('Допустимы только адреса http:// и https://');
  if (u.username || u.password) fail('Адрес не должен содержать логин и пароль');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) fail('Этот адрес недопустим');
  if (isIP(host) && isPrivateAddress(host)) fail('Адреса внутренней сети недопустимы');
  if (!host.includes('.') && !isIP(host)) fail('Укажите доменное имя сайта');
  return u;
}
