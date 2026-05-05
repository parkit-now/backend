# Parkit backend — Makefile
#
# Convenciones:
#   - `make <target>` corre desde la raíz del repo.
#   - `make help` lista todo lo disponible.
#   - Targets que asumen Supabase corriendo: dev, prod, migrate, reset, generate.
#   - Targets que levantan Supabase: up, install (idempotente).

SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

# Colores para el help
CYAN  := \033[36m
RESET := \033[0m

.PHONY: help install up down dev prod build test lint format \
        migration migration-apply generate reset seed push status studio logs clean

## ──────────────────────────────────────────────────────────────────
## Setup
## ──────────────────────────────────────────────────────────────────

help: ## Mostrar este menú
	@awk 'BEGIN {FS = ":.*?## "} \
	     /^## [A-Za-z]/ {sub("## ", ""); printf "\n$(CYAN)%s$(RESET)\n", $$0; next} \
	     /^[a-zA-Z_-]+:.*?## / {printf "  $(CYAN)%-12s$(RESET) %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo ""

install: ## Instalar bun + supabase CLI si faltan, y dependencias del proyecto
	@command -v docker >/dev/null 2>&1 || { \
		echo "✗ Docker no está instalado. https://docs.docker.com/engine/install/"; exit 1; }
	@command -v bun >/dev/null 2>&1 || { \
		echo "→ Instalando Bun..."; \
		curl -fsSL https://bun.sh/install | bash; \
		echo ""; \
		echo "⚠ Agregá esto a tu shell rc:  export PATH=\"\$$HOME/.bun/bin:\$$PATH\""; }
	@command -v supabase >/dev/null 2>&1 || { \
		echo "→ Instalando Supabase CLI..."; \
		bun add -g supabase; }
	@bun install
	@git config core.hooksPath .githooks
	@echo "✓ Pre-commit hook activado (.githooks/pre-commit)."

## ──────────────────────────────────────────────────────────────────
## Stack local
## ──────────────────────────────────────────────────────────────────

up: install ## Levantar Supabase + aplicar migraciones nuevas (preserva data)
	@supabase start
	@-supabase migration up --local
	@bun run db:generate >/dev/null
	@echo "✓ Stack listo. Corré 'make dev' para levantar la API."

down: ## Bajar el stack Supabase local
	@supabase stop

reset: ## Resetear DB local (borra data, re-aplica todas las migraciones)
	@supabase db reset
	@bun run db:generate >/dev/null

status: ## Ver estado de Supabase local
	@supabase status

studio: ## Abrir Supabase Studio en el navegador
	@echo "Studio: http://localhost:54323"
	@(command -v xdg-open >/dev/null && xdg-open http://localhost:54323 >/dev/null 2>&1) \
	  || (command -v open >/dev/null && open http://localhost:54323) || true

## ──────────────────────────────────────────────────────────────────
## Run
## ──────────────────────────────────────────────────────────────────

dev: ## API en dev (hot reload). Requiere `make up` previo
	@bun run start:dev

prod: build ## Build + correr API en modo producción
	@bun run start:prod

build: ## Compilar TS (nest build)
	@bun run build

## ──────────────────────────────────────────────────────────────────
## Calidad
## ──────────────────────────────────────────────────────────────────

test: ## Correr suite de tests
	@bun test

lint: ## ESLint con auto-fix
	@bun run lint

format: ## Prettier sobre src/
	@bun run format

## ──────────────────────────────────────────────────────────────────
## Migraciones (SQL es la fuente de verdad)
## ──────────────────────────────────────────────────────────────────

migration: ## Crear archivo vacío de migración. Uso: make migration NAME=add_vehicles
	@if [ -z "$(NAME)" ]; then \
		echo "✗ Falta NAME. Uso: make migration NAME=add_vehicles"; exit 1; fi
	@supabase migration new $(NAME)
	@echo ""
	@echo "Próximos pasos:"
	@echo "  1. Editá el archivo SQL recién creado en supabase/migrations/"
	@echo "  2. Actualizá los modelos en prisma/schema/*.prisma para reflejar el cambio"
	@echo "  3. Corré: make migration-apply"

migration-apply: ## Aplicar migraciones pendientes a DB local + regenerar cliente Prisma
	@supabase migration up --local
	@bun run db:generate >/dev/null
	@echo "✓ Migraciones aplicadas. Cliente Prisma regenerado."

generate: ## Regenerar cliente Prisma desde el schema (sin tocar la DB)
	@bun run db:generate

seed: ## Cargar usuarios de demo en Supabase Auth (solo local)
	@bun run scripts/seed.ts

push: ## Aplicar migraciones pendientes a Supabase cloud (linked). Lo normal es que esto lo corra CI/CD
	@echo "⚠ Vas a aplicar migraciones contra el proyecto Supabase linkeado."
	@echo "  Asegurate de haber corrido: supabase link --project-ref <ref>"
	@echo ""
	@supabase db push --linked

## ──────────────────────────────────────────────────────────────────
## Utilidades
## ──────────────────────────────────────────────────────────────────

logs: ## Logs de los contenedores Supabase
	@docker ps --filter "name=supabase_" --format '{{.Names}}' | xargs -I{} docker logs --tail=50 -f {}

clean: ## Borrar dist/ y node_modules/
	@rm -rf dist node_modules
