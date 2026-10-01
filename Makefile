# МедиаРадар — команды разработки. `make` без аргументов покажет список.
SHELL := /bin/bash
.DEFAULT_GOAL := help

# Переменные из .env видны всем командам. Если файла нет, make создаёт его из .env.example и перечитывает Makefile.
-include .env
export

.env:
	@cp .env.example .env
	@echo "Создан .env из .env.example"

COMPOSE := docker compose -f deploy/docker-compose.dev.yml

.PHONY: help setup deps-up deps-down deps-reset db-migrate db-seed db-reset db-demo dev build lint typecheck format format-check test e2e e2e-install check clean

help: ## Показать список команд
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: .env ## Первый запуск: установить зависимости и создать .env
	pnpm install

deps-up: ## Запустить PostgreSQL и Redis в Docker
	$(COMPOSE) up -d --wait

deps-down: ## Остановить PostgreSQL и Redis (данные сохраняются)
	$(COMPOSE) down

deps-reset: ## Остановить и УДАЛИТЬ данные PostgreSQL и Redis
	$(COMPOSE) down -v

db-migrate: ## Применить миграции БД
	pnpm db:migrate

db-seed: ## Загрузить аккаунты и реестр реальных источников, если БД пустая
	pnpm db:seed --if-empty --real

db-reset: ## Начать с чистого листа: аккаунты и реальные источники, без материалов (удаляет всё собранное!)
	pnpm db:seed --reset --real

db-demo: ## Заменить данные синтетическими (для демонстрации без интернета и для e2e-тестов; удаляет собранное!)
	pnpm db:seed --reset

dev: setup deps-up db-migrate db-seed ## Всё сразу: зависимости, БД, реальные источники, API + воркер (сбор идёт сам) + портал
	@echo ""
	@echo "Портал: http://localhost:3000   (вход: a.prokhorov@altai.media / Demo-Passw0rd!)"
	@echo "API:    http://localhost:4000/docs"
	@echo ""
	pnpm dev

build: ## Собрать все пакеты и приложения
	pnpm build

lint: ## Проверка кода (ESLint)
	pnpm lint

typecheck: ## Проверка типов TypeScript
	pnpm typecheck

format: ## Отформатировать код (Prettier)
	pnpm format

format-check: ## Проверить форматирование без изменений
	pnpm format:check

test: deps-up ## Юнит- и интеграционные тесты (нужны PostgreSQL и Redis)
	pnpm test

e2e-install: ## Один раз: скачать браузер для e2e-тестов
	pnpm --filter @mediaradar/web exec playwright install chromium

e2e: ## E2E-тесты в браузере (нужны синтетические данные: make db-demo, затем make dev)
	pnpm --filter @mediaradar/web exec playwright test

check: format-check lint typecheck test build ## То же, что проверяет CI

clean: ## Удалить сборочные артефакты
	rm -rf apps/*/dist apps/web/.next packages/*/dist .turbo apps/*/.turbo packages/*/.turbo
