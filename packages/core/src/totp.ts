import { createHmac, randomBytes } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  const clean = str.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

type Algo = 'sha1' | 'sha256' | 'sha512';

/** HOTP (RFC 4226) */
export function hotp(secret: Buffer, counter: number, digits = 6, algo: Algo = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algo, secret).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const bin =
    ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** TOTP (RFC 6238) */
export function totp(secret: Buffer, timeMs: number, opts: { step?: number; digits?: number; algo?: Algo } = {}): string {
  const { step = 30, digits = 6, algo = 'sha1' } = opts;
  return hotp(secret, Math.floor(timeMs / 1000 / step), digits, algo);
}

/**
 * Проверка кода с окном ±window шагов. Возвращает номер совпавшего шага (счётчик) или null.
 * Вызывающий хранит последний использованный счётчик и отвергает повтор (защита от replay).
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { timeMs?: number; window?: number; step?: number; digits?: number; lastCounter?: number | null } = {},
): number | null {
  const { timeMs = Date.now(), window = 1, step = 30, digits = 6, lastCounter = null } = opts;
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = Math.floor(timeMs / 1000 / step);
  for (let w = -window; w <= window; w++) {
    const counter = current + w;
    if (lastCounter !== null && counter <= lastCounter) continue;
    if (hotp(secret, counter, digits) === code) return counter;
  }
  return null;
}

export function otpauthUrl(opts: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`);
  const q = new URLSearchParams({ secret: opts.secret, issuer: opts.issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/** Резервные коды: 8 штук формата xxxxx-xxxxx. */
export function generateRecoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () => {
    const s = base32Encode(randomBytes(7)).toLowerCase().slice(0, 10);
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}
