# МедиаРадар

Платформа региональной медиа-аналитики: сбор материалов из региональных сайтов, Telegram, VK, YouTube и форумов, умная лента с фильтрами, аналитика и отчёты, алерты, роли и тарифы. Первый регион — «Алтай.Медиа» (Алтайский край).

**Состояние:** Фаза 0 из 10 выполнена — рабочий каркас: портал из прототипа на реальном API с демо-данными, вход с 2FA, роли и права, изоляция тенантов на уровне БД, реестр настроек, CI. Реальный сбор данных — Фаза 1.

```bash
make dev   # PostgreSQL + Redis в Docker, миграции, демо-данные, API + воркер + портал
```

Портал — <http://localhost:3000>, вход: `a.prokhorov@altai.media` / `Demo-Passw0rd!`.

## Документация

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — запуск, структура, правила разработки
- [docs/PLAN.md](docs/PLAN.md) — план и фазы
- [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) — продуктовая спецификация
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — архитектура
- [docs/DATA_MODEL.md](docs/DATA_MODEL.md) — модель данных
- [prototype/index.html](prototype/index.html) — исходный прототип (эталон дизайна)
