# МедиаРадар — руководство разработчика

Как запустить проект, где что лежит и как не сломать изоляцию тенантов. Состояние: **Фаза 0 выполнена** (см. [PLAN.md](PLAN.md)).

## 1. Что нужно установить

| Что | Зачем | Как |
|---|---|---|
| Node.js 22 | всё приложение (`.nvmrc`) | `nvm use` или установщик с nodejs.org |
| pnpm 10 | менеджер пакетов | `corepack enable` (версия берётся из `package.json`) |
| Docker | PostgreSQL 16 и Redis для разработки | Docker Desktop / Docker Engine + Compose v2 |
| make | короткие команды | есть в Linux/macOS; в Windows — через WSL |

Docker можно не ставить, если у вас уже есть PostgreSQL 16 и Redis: см. §8.

## 2. Быстрый старт

```bash
git clone <репозиторий> && cd MediaRadar
make dev
```

`make dev` сам: создаёт `.env` из `.env.example`, ставит зависимости, поднимает PostgreSQL и Redis в Docker, применяет миграции, загружает демо-данные (если база пустая) и запускает API, воркер и портал.

- Портал: <http://localhost:3000>
- Документация API (Swagger): <http://localhost:4000/docs>
- Проверки: `GET :4000/healthz`, `GET :4000/readyz` (БД + Redis), `GET :4000/metrics` (Prometheus; в production только с токеном)

### Демо-аккаунты

Пароль у всех: `Demo-Passw0rd!`

| Email | Роль | Тенант |
|---|---|---|
| `a.prokhorov@altai.media` | Владелец | «Алтай.Медиа» (тариф PRO) |
| `n.sergeeva@altai.media` | Администратор | «Алтай.Медиа» |
| `m.kovaleva@altai.media` | Аналитик | «Алтай.Медиа» (и читатель во втором тенанте) |
| `d.esin@altai.media` | Редактор | «Алтай.Медиа» |
| `o.timoshina@altai.media` | Модератор | «Алтай.Медиа» |
| `i.lapteva@agro22.ru` | Читатель, доступ только к темам «агро» и «пищевая промышленность» | «Алтай.Медиа» |
| `s.bashlykov@client.ru` | Читатель (заблокирован) | «Алтай.Медиа» |
| `owner@altai-republic.demo` | Владелец | «Демо-республика» (тариф STARTER) |
| `admin@mediaradar.local` | Администратор платформы | — (раздел «Администрирование») |

Данные синтетические и детерминированные (одинаковые при каждом запуске): 2 тенанта, 22 источника, ≈1500 материалов. Пока воркер работает с `DEMO_LIVE=true`, каждые несколько секунд в ленту «прилетает» новый синтетический материал — так проверяется канал реального времени.

## 3. Команды

`make help` показывает полный список. Основное:

| Команда | Что делает |
|---|---|
| `make dev` | всё сразу (см. выше) |
| `make deps-up` / `make deps-down` | PostgreSQL + Redis в Docker |
| `make deps-reset` | то же + **удаление данных** |
| `make db-migrate` | применить миграции |
| `make db-seed` | загрузить демо-данные, если база пустая |
| `make db-reset` | пересоздать демо-данные с нуля |
| `make test` | все тесты (юнит + интеграционные на реальных PostgreSQL/Redis) |
| `make e2e` | тесты в браузере (портал уже запущен через `make dev`); первый раз: `make e2e-install` |
| `make check` | то же, что проверяет CI: формат, линтер, типы, тесты, сборка |

## 4. Устройство репозитория

```
apps/
  api/      Fastify 5: REST + WebSocket, аутентификация, права, OpenAPI
  worker/   BullMQ-воркер: очередь сбора (заглушка до Фазы 1), демо-поток материалов
  web/      Next.js 16 (App Router): портал; e2e-тесты Playwright в e2e/
packages/
  core/     id (UUIDv7), крипто (AES-GCM), TOTP, пароли (argon2id), конфиг, доменные константы
  rbac/     атомы прав, роли, матрица «роль → права» (источник истины для API и интерфейса)
  settings/ реестр типизированных настроек (платформа → тенант → источник → пользователь)
  db/       миграции (SQL), клиент, сид демо-данных, хранилище настроек
  ui/       дизайн-токены, компоненты, обёртка ECharts
deploy/     docker-compose (dev/prod), Dockerfile, Caddyfile
docs/       план, архитектура, спецификация, модель данных
prototype/  исходный прототип index.html — эталон дизайна
```

Внутренние пакеты отдаются как TypeScript-исходники (`exports: ./src/index.ts`), приложения собирают их в бандл (tsup для api/worker, Next для web). Отдельной сборки пакетов нет.

## 5. Правила, которые нельзя нарушать

### 5.1 База данных и изоляция тенантов

- Миграции — обычные SQL-файлы в `packages/db/migrations/NNNN_название.sql`. Применённую миграцию **не редактируют** (проверяется контрольная сумма) — только новая миграция сверху.
- Приложение ходит в БД ролями `app_api` / `app_worker` без права обхода RLS. Владелец схемы (`MIGRATE_DATABASE_URL`) — только для миграций и сидов.
- На каждой таблице тенанта включены `ENABLE` + `FORCE ROW LEVEL SECURITY`. Новая таблица с данными тенанта: вызвать в миграции `SELECT app_rls_tenant_table('имя');` (и в конце `SELECT app_apply_grants();`), а затем **добавить её в классификацию** в `packages/db/test/rls.test.ts` — тест «все таблицы классифицированы» упадёт, пока этого не сделано, и тест изоляции для таблицы появится автоматически.
- Контекст запроса передаётся переменными сессии `app.tenant_id`, `app.user_id`, `app.platform_admin`, `app.system` — только через `db.tenant(...)`, `db.platform(...)`, `db.system(...)` из `packages/db/src/client.ts`.
- Внутри одной транзакции запросы выполняются **последовательно** (одно соединение): параллельный `Promise.all` по одному клиенту `pg` запрещён.

### 5.2 API и права

- Каждый маршрут обязан объявить доступ: `access.public()`, `.session()`, `.account()`, `.user()`, `.tenant('право')` или `.platform('право')`. Тест `permissions.test.ts` падает, если маршрут объявлен без доступа.
- Право — это атом в `packages/rbac`; интерфейс только скрывает ненужное, **решение всегда принимает сервер**. Матрица «роль × право» закреплена тестом по `PRODUCT_SPEC §8.2`.
- Мутации требуют CSRF-токен (`x-csrf-token` из cookie `mr_csrf`) и допустимый `Origin`.
- Ошибки — `application/problem+json`; тексты на русском.

### 5.3 Настройки

Новая настройка = запись в `packages/settings/src/index.ts` (ключ, область, схема Zod, значение по умолчанию, группа в интерфейсе). Изменения версионируются, пишутся в историю и аудит, откатываются.

### 5.4 Интерфейс

Цвета, радиусы, тени — только токены из `packages/ui/src/theme.css` (светлая и тёмная тема). Новые компоненты — в `packages/ui`, с тестом в `packages/ui/test`.

## 6. Тесты

- `pnpm test` (или `make test`) — всё. Для БД-тестов нужны PostgreSQL и Redis (`make deps-up`); тестовые базы (`mediaradar_test`, `mediaradar_test_api`, `mediaradar_test_worker`) создаются и заполняются автоматически и не затрагивают базу разработки.
- E2E (`make e2e`) идёт против запущенного стека и меняет состояние демо-данных: сценарий 2FA включает и затем отключает двухфакторную защиту у `o.timoshina@altai.media`. Если прогон оборвать посередине, выполните `make db-reset`.
- На вход действует лимит 20 попыток в минуту с одного IP — e2e укладывается, но не запускайте несколько прогонов одновременно.

## 7. Наблюдаемость

Структурные JSON-логи (pino, уровень — `LOG_LEVEL`, заголовки cookie, authorization и CSRF скрываются), `GET /healthz` (процесс жив), `GET /readyz` (БД и Redis доступны), `GET /metrics` — метрики Prometheus (длительность HTTP-запросов, число WebSocket-соединений, процесс и event loop Node.js; состояние очередей BullMQ видно на дашборде и пока не экспортируется в метрики); в production требуют `Authorization: Bearer <METRICS_TOKEN>`.

## 8. Без Docker

Нужны PostgreSQL 16 и Redis на localhost. Создайте суперпользователя и базу:

```sql
CREATE ROLE mediaradar LOGIN SUPERUSER PASSWORD 'mediaradar_dev';
CREATE DATABASE mediaradar OWNER mediaradar;
```

Дальше всё так же: `make setup db-migrate db-seed` и `pnpm dev`. Другие адреса задаются в `.env` (`MIGRATE_DATABASE_URL`, `DATABASE_URL`, `REDIS_URL`; для тестов — `TEST_PG_URL`, `TEST_REDIS_URL`).

## 9. Production (черновик)

`deploy/docker-compose.prod.yml` — Caddy (автоматический HTTPS) → web + api, воркер, PostgreSQL, Redis, одноразовый сервис миграций. Все секреты обязательны (`deploy/.env.prod.example`); API в production не стартует с ключом шифрования по умолчанию и без `METRICS_TOKEN`. Это каркас: образы и compose проверялись только на уровне YAML и пошаговым воспроизведением сборки; боевая проверка и бэкапы — задача Фаз 9–10.

Снаружи через Caddy закрыты `/api/metrics` и `/api/docs`.
