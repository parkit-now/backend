# Parkit — Backend — Guía Operativa para Programadores

> API HTTP del proyecto Parkit.


## 1) Requisitos

- Docker corriendo
- Bun instalado
- Supabase CLI instalada
- Node.js moderno para Prisma CLI (recomendado `>= 22.12`)

## 2) Primera vez (setup completo)

```bash
git clone git@github.com:parkit-now/backend.git
cd backend

make install
make up

cp .env.example .env
make env-print
# copiar valores sugeridos en .env
make env-check

make seed-all
make dev
```

## 3) Uso diario

Si ya tenés todo instalado:

```bash
make up
make dev
```

Opcional:

```bash
make down
make status
make studio
make logs
```

## 4) Seeds

- Global (SQL):

```bash
make seed-global
```

- Auth + memberships:

```bash
make seed-auth
```

- Tenant-local de negocio:

```bash
make seed-tenant
```

- Todo junto:

```bash
make seed-all
```

## 5) Cambios de schema / migraciones

### Nuevo cambio

```bash
make migration NAME=add_<feature>
# editar SQL en supabase/migrations/<timestamp>_add_<feature>.sql
# reflejar en prisma/schema/**

make migration-apply
make generate
bun run build
bun test
```

### Cuando traés cambios de un compañero

```bash
git pull --rebase
make migration-apply
make generate
bun run build
bun test
```

### Si tu DB local quedó inconsistente

```bash
make reset
make generate
bun run build
bun test
```

## 6) Reglas de migración importantes

- SQL en `supabase/migrations/` es la fuente de verdad.
- En producción, migraciones son append-only:
  - No editar ni borrar migraciones ya mergeadas a `main`.
  - Si te equivocás, crear una nueva migración correctiva.

## 7) Regla de DTOs (automático primero)

- Para CRUD estándar que mapea 1:1 con tablas, usar DTOs autogenerados desde `src/generated/nestjs-dto/`.
- No crear DTOs manuales para esos CRUD (dejarlos únicamente para APIs externas)
- DTO manual (`class-validator`/`class-transformer`) solo para endpoints orquestadores o contratos no-CRUD.
- Casos típicos de DTO manual: auth/login-refresh-register, healthcheck y RFC7807 de errores.

## 8) Calidad y verificación local

```bash
make lint
make test
bun run build
```

Smoke recomendado antes de PR:

```bash
make reset
make migration-apply
make generate
bun run build
bun test
```

## 9) Git workflow (resumen operativo)

### Crear rama

```bash
git switch main
git pull --rebase origin main
git switch -c feat/SCRUM-123-descripcion
```

### Commit

Usar Conventional Commits:

```bash
git add .
git commit -m "feat(scope): descripcion"
```

### Push

```bash
git push -u origin feat/SCRUM-123-descripcion
```

Si hiciste rebase y reescribiste historia:

```bash
git push --force-with-lease
```

### PR / Merge

- PR siempre a `main`.
- Mínimo 1 reviewer.
- CI en verde obligatorio.
- Preferir squash & merge.

## 10) Validación en develop (staging)

El equipo usa `develop` como entorno compartido de validación integrada.
Seguir exactamente el procedimiento de `CONTRIBUTING.md` para evitar pisar trabajo ajeno.

## 11) CI/CD que te impacta

En PR se valida:

- lint
- typecheck
- test
- migration smoke (`make reset`, `make migration-apply`, `make generate`, `build`, `test`)

Si rompés migraciones o generación de cliente/DTOs, el PR no pasa.

## 12) Referencias obligatorias

- Arquitectura de modelos: [ADDING_NEW_MODELS.md](./ADDING_NEW_MODELS.md)
- Guía de contribución: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Pipeline de GitHub: [.github/workflows/README.md](./.github/workflows/README.md)
- Comandos disponibles: `make help`


## URLs locales

Con `make up` + `make dev`:

- API: http://localhost:3000
- Swagger UI: http://localhost:3000/api
- Swagger JSON: http://localhost:3000/api-json
- Supabase Studio: http://localhost:54323
- Mailpit: http://localhost:54324
