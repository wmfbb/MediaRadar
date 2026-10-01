import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/client';
import { clearSetting, effectiveSettings, getSetting, loadSettingRows, rollbackSetting, setSetting, settingHistory } from '../src/settings-store';
import { apiDb, loadIds, withAdmin, type Ids } from './helpers';

let api: Db;
let ids: Ids;
beforeAll(async () => {
  api = apiDb();
  ids = await loadIds();
});
afterAll(async () => {
  await withAdmin(async (c) => {
    await c.query("DELETE FROM settings WHERE key IN ('backfill.defaultDepthDays', 'content.excerpt.maxChars', 'ui.theme.default', 'moderation.mode', 'schedule.minIntervalSec')");
    await c.query("DELETE FROM settings_history WHERE key IN ('backfill.defaultDepthDays', 'ui.theme.default', 'moderation.mode', 'schedule.minIntervalSec')");
  });
  await api.close();
});

const tenantTarget = (key: string, t: string) => ({ key, scope: 'tenant' as const, scopeId: t, tenantId: t });

describe('хранилище настроек', () => {
  it('значение тенанта перекрывает платформенное и умолчание; другой тенант не затронут', async () => {
    const A = ids.tenantA;
    const key = 'backfill.defaultDepthDays';
    expect(await api.tenant({ tenantId: A }, (q) => getSetting(q, key, { tenantId: A }))).toBe(365);
    await api.platform(ids.users['admin@mediaradar.local']!, (q) => setSetting(q, { key, scope: 'platform', scopeId: null, tenantId: null }, 180));
    expect(await api.tenant({ tenantId: A }, (q) => getSetting(q, key, { tenantId: A }))).toBe(180);
    await api.tenant({ tenantId: A, userId: ids.users['a.prokhorov@altai.media'] }, (q) => setSetting(q, tenantTarget(key, A), 90, { actorId: ids.users['a.prokhorov@altai.media'] }));
    expect(await api.tenant({ tenantId: A }, (q) => getSetting(q, key, { tenantId: A }))).toBe(90);
    expect(await api.tenant({ tenantId: ids.tenantB }, (q) => getSetting(q, key, { tenantId: ids.tenantB }))).toBe(180);
  });

  it('история фиксирует изменения, откат возвращает прошлое значение', async () => {
    const A = ids.tenantA;
    const key = 'backfill.defaultDepthDays';
    const actor = ids.users['a.prokhorov@altai.media']!;
    await api.tenant({ tenantId: A, userId: actor }, async (q) => {
      await setSetting(q, tenantTarget(key, A), 60, { actorId: actor, reason: 'эксперимент' });
      const hist = await settingHistory(q, key, 'tenant', A);
      expect(hist[0]!.new_value).toBe(60);
      expect(hist[0]!.old_value).toBe(90);
      expect(hist[0]!.reason).toBe('эксперимент');
      await rollbackSetting(q, hist[0]!.id, { actorId: actor });
      expect(await getSetting(q, key, { tenantId: A })).toBe(90);
      const after = await settingHistory(q, key, 'tenant', A);
      expect(after[0]!.reason).toMatch(/откат/);
    });
  });

  it('сброс удаляет значение уровня; откат первого значения тоже его удаляет', async () => {
    const A = ids.tenantA;
    const key = 'moderation.mode';
    await api.tenant({ tenantId: A }, async (q) => {
      expect(await getSetting(q, key, { tenantId: A })).toBe('auto');
      await setSetting(q, tenantTarget(key, A), 'manual');
      expect(await getSetting(q, key, { tenantId: A })).toBe('manual');
      expect(await clearSetting(q, tenantTarget(key, A))).toBe(true);
      expect(await getSetting(q, key, { tenantId: A })).toBe('auto');
      expect(await clearSetting(q, tenantTarget(key, A))).toBe(false);
      await setSetting(q, tenantTarget(key, A), 'hybrid');
      const first = (await settingHistory(q, key, 'tenant', A)).find((h) => h.old_value === null)!;
      await rollbackSetting(q, first.id);
      expect(await getSetting(q, key, { tenantId: A })).toBe('auto');
    });
  });

  it('валидация: плохие значения, недопустимые уровни, чужой tenantId', async () => {
    const A = ids.tenantA;
    await api.tenant({ tenantId: A }, async (q) => {
      await expect(setSetting(q, tenantTarget('backfill.defaultDepthDays', A), 0)).rejects.toThrow(/Недопустимое значение/);
      await expect(setSetting(q, tenantTarget('backfill.defaultDepthDays', A), 'x')).rejects.toThrow();
      await expect(setSetting(q, tenantTarget('fetch.userAgent', A), 'MyBot/1.0')).rejects.toThrow(/не может задаваться/);
      await expect(setSetting(q, tenantTarget('no.such', A), 1)).rejects.toThrow(/Неизвестная/);
      await expect(setSetting(q, { key: 'ui.theme.default', scope: 'tenant', scopeId: A, tenantId: null }, 'dark')).rejects.toThrow(/tenantId/);
    });
  });

  it('тенант не может писать платформенный уровень и значения другого тенанта', async () => {
    const A = ids.tenantA;
    await expect(api.tenant({ tenantId: A }, (q) => setSetting(q, { key: 'schedule.minIntervalSec', scope: 'platform', scopeId: null, tenantId: null }, 30))).rejects.toThrow(/row-level security/i);
    await expect(api.tenant({ tenantId: A }, (q) => setSetting(q, tenantTarget('content.excerpt.maxChars', ids.tenantB), 999))).rejects.toThrow(/row-level security/i);
  });

  it('уровень «пользователь»: значение видит только владелец', async () => {
    const [alex, maria] = [ids.users['a.prokhorov@altai.media']!, ids.users['m.kovaleva@altai.media']!];
    const A = ids.tenantA;
    await api.tenant({ tenantId: A, userId: alex }, (q) => setSetting(q, { key: 'ui.theme.default', scope: 'user', scopeId: alex, tenantId: A }, 'dark'));
    expect(await api.tenant({ tenantId: A, userId: alex }, (q) => getSetting(q, 'ui.theme.default', { tenantId: A, userId: alex }))).toBe('dark');
    const rows = await api.tenant({ tenantId: A, userId: maria }, (q) => loadSettingRows(q, ['ui.theme.default']));
    expect(rows).toHaveLength(0);
    await expect(api.tenant({ tenantId: A, userId: maria }, (q) => setSetting(q, { key: 'ui.theme.default', scope: 'user', scopeId: alex, tenantId: A }, 'light'))).rejects.toThrow(/row-level security/i);
  });

  it('оптимистичная блокировка по версии', async () => {
    const A = ids.tenantA;
    await api.tenant({ tenantId: A }, async (q) => {
      await setSetting(q, tenantTarget('content.excerpt.maxChars', A), 300);
      const { version } = await setSetting(q, tenantTarget('content.excerpt.maxChars', A), 350, { expectedVersion: 1 });
      expect(version).toBe(2);
      await expect(setSetting(q, tenantTarget('content.excerpt.maxChars', A), 400, { expectedVersion: 1 })).rejects.toThrow(/изменена другим/);
    });
  });

  it('effectiveSettings: сводка по всем определениям с уровнями', async () => {
    const A = ids.tenantA;
    const rows = await api.tenant({ tenantId: A }, (q) => loadSettingRows(q));
    const eff = effectiveSettings(rows, { tenantId: A });
    const depth = eff.find((e) => e.key === 'backfill.defaultDepthDays')!;
    expect(depth.from).toBe('tenant');
    expect(depth.levels.platform?.value).toBe(180);
    expect(depth.levels.tenant?.value).toBe(90);
    expect(eff.find((e) => e.key === 'retention.articleDays')!.from).toBe('default');
    expect(eff.length).toBeGreaterThan(50);
  });
});
