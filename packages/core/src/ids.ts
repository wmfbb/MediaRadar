import { randomBytes } from 'node:crypto';

let lastMs = 0;
let seq = 0;

/**
 * UUIDv7 (RFC 9562): 48 бит времени в мс + случайные биты.
 * Внутри одной миллисекунды сохраняется монотонность за счёт счётчика в rand_a.
 */
export function uuidv7(now: number = Date.now()): string {
  const rnd = randomBytes(10);
  if (now > lastMs) {
    lastMs = now;
    seq = ((rnd[0]! << 4) | (rnd[1]! >> 4)) & 0x7ff; // стартуем с половины диапазона, чтобы не переполниться
  } else {
    now = lastMs;
    seq = (seq + 1) & 0xfff;
    if (seq === 0) {
      lastMs += 1;
      now = lastMs;
    }
  }
  const b = Buffer.alloc(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = 0x70 | ((seq >> 8) & 0x0f);
  b[7] = seq & 0xff;
  b[8] = 0x80 | (rnd[2]! & 0x3f);
  rnd.copy(b, 9, 3, 10);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
