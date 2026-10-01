import { describe, expect, it } from 'vitest';
import {
  AppError, DEV_ENCRYPTION_KEY, base32Decode, base32Encode, checkPasswordPolicy, decryptSecret, encryptSecret,
  generateRecoveryCodes, hashPassword, hotp, isUuid, loadConfig, parseEncryptionKey, sentimentFromScore,
  totp, uuidv7, verifyPassword, verifyTotp,
} from '../src';

describe('uuidv7', () => {
  it('валиден, версия 7, вариант 10', () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]);
  });
  it('монотонен: сортировка по строке = порядок генерации', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('AES-256-GCM', () => {
  const key = parseEncryptionKey(DEV_ENCRYPTION_KEY);
  it('шифрует и расшифровывает', () => {
    const ct = encryptSecret('секрет 🔐', key);
    expect(ct.startsWith('v1.')).toBe(true);
    expect(decryptSecret(ct, key)).toBe('секрет 🔐');
  });
  it('шифртекст недетерминирован', () => {
    expect(encryptSecret('a', key)).not.toBe(encryptSecret('a', key));
  });
  it('подмена ломает расшифровку', () => {
    const parts = encryptSecret('hello', key).split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
  });
  it('неверный ключ отвергается', () => {
    expect(() => parseEncryptionKey('c2hvcnQ=')).toThrow();
  });
});

describe('TOTP (RFC 6238, SHA-1, 8 цифр)', () => {
  const secret = Buffer.from('12345678901234567890');
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  it.each(vectors)('t=%i → %s', (t, code) => {
    expect(totp(secret, t * 1000, { digits: 8 })).toBe(code);
  });
  it('HOTP RFC 4226: счётчик 0 → 755224', () => {
    expect(hotp(secret, 0)).toBe('755224');
  });
  it('base32 round-trip', () => {
    const buf = Buffer.from('hello world');
    expect(base32Decode(base32Encode(buf)).toString()).toBe('hello world');
  });
  it('verifyTotp: окно ±1 и защита от повтора', () => {
    const s = base32Encode(secret);
    const now = 1_700_000_000_000;
    const code = totp(secret, now);
    const counter = verifyTotp(s, code, { timeMs: now });
    expect(counter).not.toBeNull();
    expect(verifyTotp(s, code, { timeMs: now, lastCounter: counter })).toBeNull();
    expect(verifyTotp(s, totp(secret, now - 30_000), { timeMs: now })).not.toBeNull();
    expect(verifyTotp(s, totp(secret, now - 120_000), { timeMs: now })).toBeNull();
    expect(verifyTotp(s, 'abcdef', { timeMs: now })).toBeNull();
  });
  it('резервные коды уникальны', () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(8);
    expect(codes[0]).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
  });
});

describe('пароли', () => {
  it('argon2id: хэш проверяется, чужой пароль нет', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong horse battery')).toBe(false);
    expect(await verifyPassword('garbage', 'x')).toBe(false);
  });
  it('политика', () => {
    expect(checkPasswordPolicy('short')).toMatch(/10 символов/);
    expect(checkPasswordPolicy('password123')).toMatch(/10 символов|простой/);
    expect(checkPasswordPolicy('aaaaaaaaaaaa')).toMatch(/разных/);
    expect(checkPasswordPolicy('ivan.petrov-secret', { email: 'ivan.petrov@x.ru' })).toMatch(/почты/);
    expect(checkPasswordPolicy('Хорошая-длинная-фраза-42')).toBeNull();
  });
});

describe('конфиг', () => {
  const base = { DATABASE_URL: 'postgres://x' };
  it('значения по умолчанию', () => {
    const c = loadConfig(base);
    expect(c.API_PORT).toBe(4000);
    expect(c.isProd).toBe(false);
    expect(c.encryptionKey.length).toBe(32);
  });
  it('production запрещает dev-ключ и требует METRICS_TOKEN', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/APP_ENCRYPTION_KEY/);
    const key = Buffer.alloc(32, 7).toString('base64');
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', APP_ENCRYPTION_KEY: key })).toThrow(/METRICS_TOKEN/);
    expect(loadConfig({ ...base, NODE_ENV: 'production', APP_ENCRYPTION_KEY: key, METRICS_TOKEN: 't' }).isProd).toBe(true);
  });
  it('ошибка читается по-русски и называет поле', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});

describe('домен', () => {
  it('скор → 5 градаций', () => {
    expect(sentimentFromScore(0.9)).toBe('VP');
    expect(sentimentFromScore(0.3)).toBe('P');
    expect(sentimentFromScore(0)).toBe('N');
    expect(sentimentFromScore(-0.4)).toBe('NG');
    expect(sentimentFromScore(-0.9)).toBe('VN');
  });
  it('AppError несёт HTTP-статус', () => {
    expect(new AppError('forbidden', 'x').status).toBe(403);
    expect(new AppError('rate_limited', 'x').status).toBe(429);
  });
});
