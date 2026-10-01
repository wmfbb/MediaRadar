import { expect, test, type Page } from '@playwright/test';
import { OWNER, login, loginAndWait, logout, totpCode, DEMO_PASSWORD } from './helpers';

/** Блок ошибки формы (без служебного анонсера маршрутов Next.js). */
const alertBox = (page: Page) => page.locator('[role=alert]:not(#__next-route-announcer__)');

const SCREENS: Array<[string, string]> = [
  ['/', 'Медиаландшафт: Алтайский край'],
  ['/feed', 'Умные фильтры контента'],
  ['/analytics', 'Отчёты и визуализация данных'],
  ['/sources', 'Реестр ресурсов и парсеры'],
  ['/alerts', 'Правила и алерты'],
  ['/reports', 'Конструктор отчётов'],
  ['/users', 'Пользователи и роли'],
  ['/settings', 'Настройки'],
  ['/billing', 'Тарифы и оплата'],
  ['/account', 'Профиль и безопасность'],
];

/** Собирает ошибки консоли и неудачные ответы API — на «здоровых» экранах их быть не должно. */
function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().includes('/api/')) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return problems;
}

test.describe('вход и доступ', () => {
  test('гость перенаправляется на /login и после входа возвращается на нужную страницу', async ({ page }) => {
    await page.goto('/feed');
    await expect(page).toHaveURL(/\/login\?next=%2Ffeed/);
    await page.getByLabel('Email').fill(OWNER);
    await page.getByLabel('Пароль').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page).toHaveURL(/\/feed$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Умные фильтры контента' })).toBeVisible();
  });

  test('неверный пароль показывает ошибку и не пускает', async ({ page }) => {
    await login(page, OWNER, 'wrong-password-123');
    await expect(alertBox(page)).toContainText('Неверный email или пароль');
    await expect(page).toHaveURL(/\/login/);
  });

  test('выход закрывает сессию', async ({ page }) => {
    await loginAndWait(page, OWNER);
    await logout(page);
    await page.goto('/sources');
    await expect(page).toHaveURL(/\/login/);
  });

  test('читатель с ограничением по темам видит только разрешённые разделы и темы', async ({ page }) => {
    await loginAndWait(page, 'i.lapteva@agro22.ru');
    const nav = page.getByRole('navigation', { name: 'Главная навигация' });
    await expect(nav.getByRole('link', { name: 'Лента' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Пользователи и роли' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Настройки' })).toHaveCount(0);
    await page.goto('/feed');
    await expect(page.getByRole('heading', { level: 1, name: 'Умные фильтры контента' })).toBeVisible();
    // ABAC: сервер отдаёт только материалы разрешённых тем, а счётчики запрещённых тем в фильтрах нулевые.
    const res = await page.request.get('/api/v1/articles?limit=50');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { items: Array<{ topic: { key: string } | null }> };
    expect(body.items.length).toBeGreaterThan(0);
    for (const it of body.items) expect(['agro', 'food']).toContain(it.topic?.key);
    await expect(page.getByRole('button', { name: /Госуправление\s*0$/ })).toBeVisible();
  });
});

test.describe('экраны владельца тенанта', () => {
  test('все экраны открываются без ошибок консоли и сети', async ({ page }) => {
    const problems = watchProblems(page);
    await loginAndWait(page, OWNER);
    for (const [path, title] of SCREENS) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await page.waitForLoadState('networkidle');
    }
    expect(problems.filter((p) => !p.includes('ERR_ABORTED'))).toEqual([]);
  });

  test('индикатор потока подключается по WebSocket', async ({ page }) => {
    await loginAndWait(page, OWNER);
    await expect(page.getByRole('status', { name: /Поток в реальном времени/ })).toContainText('подключено');
  });

  test('новые материалы приходят на дашборд без перезагрузки', async ({ page }) => {
    test.skip(!process.env.E2E_LIVE, 'нужен запущенный worker с DEMO_LIVE=true (E2E_LIVE=1)');
    await loginAndWait(page, OWNER);
    await expect(page.locator('li.mr-slide-in').first()).toBeVisible({ timeout: 30_000 });
  });

  test('фильтры ленты: поиск по префиксу и сохранение состояния в URL', async ({ page }) => {
    await loginAndWait(page, OWNER);
    await page.goto('/feed');
    await page.getByPlaceholder(/Полнотекстовый поиск/).fill('барнаул');
    await expect(page).toHaveURL(/q=/);
    await expect(page.getByText(/Найдено:/)).toBeVisible();
  });

  test('палитра команд (Ctrl+K) ведёт на нужный экран', async ({ page }) => {
    await loginAndWait(page, OWNER);
    await page.keyboard.press('Control+K');
    const input = page.getByRole('textbox', { name: 'Команда или поисковый запрос' });
    await expect(input).toBeVisible();
    await input.fill('Источники');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/sources$/);
  });

  test('тема сохраняется между перезагрузками', async ({ page }) => {
    await loginAndWait(page, OWNER);
    await page.getByRole('button', { name: /Алексей Прохоров/ }).click();
    await page.getByRole('menuitemradio', { name: 'Тёмная' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByRole('button', { name: /Алексей Прохоров/ }).click();
    await page.getByRole('menuitemradio', { name: 'Светлая' }).click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  });
});

test.describe('панель платформы', () => {
  test('супер-админ видит тенантов и журнал аудита, владелец тенанта — нет', async ({ page }) => {
    await loginAndWait(page, 'admin@mediaradar.local');
    await page.goto('/admin/tenants');
    await expect(page.getByText('altai-krai')).toBeVisible();
    await expect(page.getByText('demo-republic')).toBeVisible();
    await page.goto('/admin/audit');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await logout(page);

    await loginAndWait(page, OWNER);
    const res = await page.request.get('/api/v1/admin/tenants');
    expect(res.status()).toBe(403);
  });
});

test.describe('двухфакторная защита', () => {
  test('включение через интерфейс, вход с кодом, отключение', async ({ page }) => {
    test.setTimeout(120_000);
    const email = 'o.timoshina@altai.media';
    const STEP = 30_000;
    await loginAndWait(page, email);
    await page.goto('/account');
    await page.getByRole('button', { name: 'Включить' }).click();
    const secret = (await page.locator('code').filter({ hasText: /^[A-Z2-7]{16,}$/ }).first().innerText()).trim();
    const t0 = Date.now();
    const c0 = Math.floor(t0 / STEP);
    await page.getByLabel('Код', { exact: true }).fill(totpCode(secret, t0));
    await page.getByRole('button', { name: 'Включить' }).last().click();
    await expect(page.getByText('Двухфакторная защита включена.')).toBeVisible();
    await expect(page.getByText('Резервные коды', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Продолжить' }).click();
    await logout(page);

    // Повтор уже использованного кода сервер отвергает (replay), поэтому берём код следующего окна (сервер допускает ±1 окно).
    await login(page, email);
    await expect(page).toHaveURL(/\/login\/mfa/);
    await page.getByLabel('Код', { exact: true }).fill('000000');
    await page.getByRole('button', { name: 'Подтвердить' }).click();
    await expect(alertBox(page)).toContainText('Неверный код');
    await page.getByLabel('Код', { exact: true }).fill(totpCode(secret, (c0 + 1) * STEP));
    await page.getByRole('button', { name: 'Подтвердить' }).click();
    await expect(page).toHaveURL(/\/$/);

    // Откат, чтобы тест можно было запускать повторно: код окна c0+2 принимается, когда текущее окно >= c0+1.
    await page.goto('/account');
    await page.getByRole('button', { name: 'Отключить' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Пароль').fill(DEMO_PASSWORD);
    await page.waitForTimeout(Math.max(0, (c0 + 1) * STEP - Date.now()) + 500);
    await dialog.getByLabel('Код из приложения').fill(totpCode(secret, (c0 + 2) * STEP));
    await dialog.getByRole('button', { name: 'Отключить' }).click();
    await expect(page.getByText('Двухфакторная защита отключена')).toBeVisible();
  });
});
