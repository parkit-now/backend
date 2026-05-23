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

ENV_LOCAL := .env.local
ENV_PROD  := .env.production

.PHONY: help install up down dev prod build test lint format \
        migration migration-apply generate reset seed-all seed-global seed-auth seed-tenant \
        env-check env-print env-use-local env-use-prod \
        push push-dry-run push-linked status studio logs clean

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
	@supabase migration up --local
	@bun run db:generate >/dev/null
	@echo "✓ Stack listo. Corré 'make dev' para levantar la API."

down: ## Bajar el stack Supabase local
	@supabase stop

reset: ## Resetear DB local (borra data, re-aplica todas las migraciones)
	@supabase db reset
	@bun run db:generate >/dev/null

status: ## Ver estado de Supabase local
	@supabase status

env-print: ## Mostrar variables locales sugeridas desde `supabase status -o env`
	@supabase status -o env

env-check: ## Validar que `.env` tenga variables críticas completas (sin placeholders)
	@if [ ! -f .env ]; then \
		echo "✗ Falta .env. Corré: cp .env.example .env"; exit 1; fi
	@set -a; . ./.env; set +a; \
	for v in DATABASE_URL DIRECT_URL SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_JWT_SECRET; do \
		val="$${!v:-}"; \
		if [ -z "$$val" ]; then \
			echo "✗ $$v está vacía en .env"; exit 1; \
		fi; \
		if [[ "$$val" == \<* ]] || [[ "$$val" == *"[REF]"* ]] || [[ "$$val" == *"[PWD]"* ]]; then \
			echo "✗ $$v parece placeholder ($$val). Completala con valores reales."; exit 1; \
		fi; \
	done; \
	oauth_missing=0; \
	for v in SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET; do \
		val="$${!v:-}"; \
		if [ -z "$$val" ]; then \
			echo "⚠ $$v no está seteada en .env"; \
			oauth_missing=1; \
			continue; \
		fi; \
		if [[ "$$val" == \<* ]] || [[ "$$val" == *"[REF]"* ]] || [[ "$$val" == *"[PWD]"* ]]; then \
			echo "⚠ $$v parece placeholder ($$val)."; \
			oauth_missing=1; \
		fi; \
	done; \
	if [ "$$oauth_missing" -eq 1 ]; then \
		echo "⚠ Login social (Google/GitHub) quedará deshabilitado localmente hasta completar esas variables."; \
	fi
	@echo "✓ .env validado."

studio: ## Abrir Supabase Studio en el navegador
	@echo "Studio: http://localhost:54323"
	@(command -v xdg-open >/dev/null && xdg-open http://localhost:54323 >/dev/null 2>&1) \
	  || (command -v open >/dev/null && open http://localhost:54323) || true

## ──────────────────────────────────────────────────────────────────
## Run
## ──────────────────────────────────────────────────────────────────

env-use-local: ## Activar entorno local (copia .env.local → .env)
	@if [ ! -f $(ENV_LOCAL) ]; then \
		echo "✗ Falta $(ENV_LOCAL). Si ya tenés un .env de dev, renombralo:  mv .env .env.local"; \
		exit 1; \
	fi
	@cp $(ENV_LOCAL) .env
	@echo "✓ .env apunta a entorno LOCAL ($(ENV_LOCAL))"

env-use-prod: ## Activar entorno produccion (copia .env.production → .env)
	@if [ ! -f $(ENV_PROD) ]; then \
		echo "✗ Falta $(ENV_PROD). Copialo desde .env.production.example y completá valores reales."; \
		exit 1; \
	fi
	@echo "⚠ Vas a usar .env.production: el backend va a conectarse a la DB de PRODUCCION."
	@cp $(ENV_PROD) .env
	@echo "✓ .env apunta a entorno PRODUCCION ($(ENV_PROD))"

dev: env-use-local ## API en dev (hot reload). Usa .env.local. Requiere `make up` previo
	@bun run start:dev

prod: env-use-prod build ## Build + correr API contra entorno PROD (cuidado: DB real)
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

seed-all: seed-global seed-auth seed-tenant ## Ejecutar todas las seeds de desarrollo local
	@echo "✓ Seed completo aplicado."

seed-global: ## Aplicar seed SQL global (tenants + catálogo global) sobre DB local
	@supabase start >/dev/null
	@supabase db query --local --file supabase/seed.sql >/dev/null
	@echo "✓ Seed global aplicado."

seed-auth: env-check ## Cargar usuarios/memberships de demo en Supabase Auth (solo local)
	@bun run scripts/seed-auth.ts

seed-tenant: env-check ## Cargar datos tenant-locales de demo (entries por tenant)
	@bun run scripts/seed-tenant.ts

push: ## Aplicar migraciones a DB remota usando DIRECT_URL de `.env` (sin `supabase link`)
	@if [ ! -f .env ]; then \
		echo "✗ Falta .env. Corré: cp .env.example .env"; exit 1; fi
	@set -a; . ./.env; set +a; \
	db_url="$${DIRECT_URL:-}"; \
	if [ -z "$$db_url" ]; then \
		echo "✗ DIRECT_URL está vacía en .env"; exit 1; \
	fi; \
	if [[ "$$db_url" == \<* ]] || [[ "$$db_url" == *"[REF]"* ]] || [[ "$$db_url" == *"[PWD]"* ]]; then \
		echo "✗ DIRECT_URL parece placeholder. Completala con tu URL real."; exit 1; \
	fi; \
	if [[ "$$db_url" == *"localhost"* ]] || [[ "$$db_url" == *"127.0.0.1"* ]]; then \
		echo "✗ DIRECT_URL apunta a local. Para push remoto descomentá tu DIRECT_URL cloud en .env."; exit 1; \
	fi; \
	echo "⚠ Vas a aplicar migraciones contra la DB remota definida en DIRECT_URL."; \
	echo "  Recomendado: corré antes 'make push-dry-run'."; \
	echo ""; \
	supabase db push --db-url "$$db_url"

push-dry-run: ## Preview de migraciones remotas usando DIRECT_URL de `.env` (sin aplicar cambios)
	@if [ ! -f .env ]; then \
		echo "✗ Falta .env. Corré: cp .env.example .env"; exit 1; fi
	@set -a; . ./.env; set +a; \
	db_url="$${DIRECT_URL:-}"; \
	if [ -z "$$db_url" ]; then \
		echo "✗ DIRECT_URL está vacía en .env"; exit 1; \
	fi; \
	if [[ "$$db_url" == \<* ]] || [[ "$$db_url" == *"[REF]"* ]] || [[ "$$db_url" == *"[PWD]"* ]]; then \
		echo "✗ DIRECT_URL parece placeholder. Completala con tu URL real."; exit 1; \
	fi; \
	if [[ "$$db_url" == *"localhost"* ]] || [[ "$$db_url" == *"127.0.0.1"* ]]; then \
		echo "✗ DIRECT_URL apunta a local. Para dry-run remoto descomentá tu DIRECT_URL cloud en .env."; exit 1; \
	fi; \
	supabase db push --db-url "$$db_url" --dry-run

push-linked: ## Aplicar migraciones al proyecto Supabase linkeado (flujo alternativo)
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
