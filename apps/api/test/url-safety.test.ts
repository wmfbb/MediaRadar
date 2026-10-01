import { describe, expect, it } from 'vitest';
import { assertPublicHttpUrl, isPrivateAddress } from '../src/lib/url-safety';
import { slugify } from '../src/lib/slug';

describe('защита от SSRF при добавлении источника', () => {
  it.each([
    'http://localhost/', 'http://LOCALHOST:8080/x', 'http://127.0.0.1/', 'http://127.1.2.3/', 'http://10.0.0.5/', 'http://172.16.0.1/', 'http://172.31.255.255/',
    'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/', 'http://0.0.0.0/', 'http://[::1]/', 'http://[fd00::1]/',
    'http://[fe80::1]/', 'http://[::ffff:10.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::10.0.0.1]/', 'http://[64:ff9b::a00:1]/', 'http://[2002:a00:1::]/', 'http://[ff02::1]/', 'http://metadata.google.internal/', 'http://db.internal/', 'http://printer.local/', 'http://app.localhost/',
    'ftp://example.ru/', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@example.ru/', 'http://intranet/', 'not a url', '',
  ])('отклоняет %s', (url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow();
  });

  it.each(['https://altapress.ru/', 'http://example.ru/news?page=2', 'https://t.me/barnaul_live', 'https://sub.domain.example.com:8443/path', 'http://8.8.8.8/'])('допускает %s', (url) => {
    expect(assertPublicHttpUrl(url).hostname).toBeTruthy();
  });

  it('isPrivateAddress: границы диапазонов', () => {
    expect(isPrivateAddress('172.15.255.255')).toBe(false);
    expect(isPrivateAddress('172.16.0.0')).toBe(true);
    expect(isPrivateAddress('172.32.0.0')).toBe(false);
    expect(isPrivateAddress('100.63.255.255')).toBe(false);
    expect(isPrivateAddress('100.127.255.255')).toBe(true);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateAddress('::ffff:0a00:0001')).toBe(true);
    expect(isPrivateAddress('garbage::::')).toBe(false); // не IP-адрес — проверяется как имя хоста
  });
});

describe('slugify', () => {
  it('транслитерирует и чистит', () => {
    expect(slugify('Алтайский край')).toBe('altayskiy-kray');
    expect(slugify('  Мой  Регион!! 2027 ')).toBe('moy-region-2027');
    expect(slugify('Я')).toMatch(/^ws-/);
    expect(slugify('A'.repeat(100)).length).toBeLessThanOrEqual(40);
    expect(slugify('Тест')).toMatch(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/);
  });
});
