# AGENT GUIDE (IA) — Parkit Backend

Documento operativo para agentes IA que trabajen sobre este repo.

## 1) Misión y prioridad

Tu objetivo es producir cambios seguros, reproducibles y alineados con arquitectura.
Prioridades:

1. No romper aislamiento multi-tenant.
2. Mantener SQL en `supabase/migrations/` como source of truth.
3. Mantener consistencia entre migraciones, schema Prisma/ZenStack y código Nest.
4. Entregar cambios verificables (`build`, `test`, smoke de migraciones).

## 2) Fuentes de verdad obligatorias

Antes de cambiar código, revisar siempre:

- `ADDING_NEW_MODELS.md`
- `CONTRIBUTING.md`
- `.github/workflows/README.md`
- `Makefile`

## 3) Contexto arquitectónico del proyecto

- DB única (Supabase/PostgreSQL) con dos capas lógicas:
  - Global (`users`, `tenants`, `vehicles`, etc)
  - Tenant-local (`entries` y futuros módulos)
- Defensa en profundidad:
  - Capa app (`getTenantClient()`, validaciones de membership/tenant automáticas vía Guards/Interceptors)
  - Capa DB (RLS + policies SQL)
- Migraciones SQL son append-only en prod (no editar archivos ya mergeados a `main`).

## 4) Regla estricta de DTOs

### REGLA DE ARQUITECTURA: Estrategia Híbrida de DTOs (ZenStack vs. Manuales)

1. **DTOs auto-generados (ZenStack)**
   - Usar para CRUD estándar 1:1 con modelo de DB.
   - Importar tipos/DTOs generados desde `.zmodel`.
   - No crear DTOs manuales para esos casos.

2. **DTOs manuales (`class-validator`/`class-transformer`)**
   - Usar para endpoints orquestadores o lógica compleja no 1:1.
   - Casos obligatorios:
     - Webhooks de hardware (LPR).
     - Integraciones de pagos (Mercado Pago).
     - Reportes/estadísticas con filtros combinados.
     - Operaciones multi-mutación sobre varias tablas.

Objetivo: DRY en CRUD estándar, control estricto de contratos en APIs críticas.

Aplicación en este repo (estado actual):
- CRUD de dominio debe importar desde `src/generated/nestjs-dto/`.
- DTO manual permitido solo en contratos no-CRUD (por ejemplo `src/auth/dto`, `src/health/dto`, `src/utils/exceptions/dto`).

## OAuth social (Google/GitHub)

- No crear endpoints OAuth en NestJS para este alcance.
- OAuth se inicia en cliente (web/desktop) con `supabase-js`; backend solo valida JWT bearer.
- Para evitar `User not provisioned`, mantener aplicada la migración SQL de provisioning automático (`auth.users` -> `public.users` con rol `driver`).
- Config local: `supabase/config.toml` + variables `SUPABASE_AUTH_EXTERNAL_*` en `.env`.
- Config cloud: replicar providers/redirects en Supabase Dashboard.
- `make env-check` debe advertir (no bloquear) cuando falten variables OAuth locales.
- Hardening operativo:
  - mantener `enable_manual_linking = false`;
  - revisar política de verificación de email/proveedor antes de prod.

## 5) Reglas de seguridad multi-tenant

Para cualquier modelo tenant-local, el agente DEBE verificar:

1. Tabla con `tenant_id` + FK en migración SQL.
2. Modelo agregado a `TENANT_MODELS` (`src/database/prisma-tenant.ts`).
3. Controlador con `@UseInterceptors(TenantInterceptor)` y `@UseGuards(TenantMembershipGuard)`.
4. Servicio usando `this.prisma.getTenantClient().model` (PROHIBIDO pasar `tenantId` manualmente).
5. RLS/policies SQL correspondientes.

### Prohibición explícita

No usar `Scope.REQUEST` para `PrismaService`.
Para contexto por request, usar `TenantContextService` (vía `AsyncLocalStorage`) inyectado automáticamente por el `TenantInterceptor`.
**Nunca pasar `tenantId` como argumento en métodos de servicios de negocio.**

## 6) Flujo canónico para cambios de schema

1. Crear migración:

```bash
make migration NAME=add_<feature>
```

2. Editar SQL en `supabase/migrations/<timestamp>_add_<feature>.sql`.
3. Reflejar cambio en `prisma/schema/**` (o capa de modelado vigente).
4. Aplicar/regen:

```bash
make migration-apply
make generate
```

5. Validar:

```bash
bun run build
bun test
```

## 7) Seeds oficiales de desarrollo

- Global SQL: `make seed-global` (`supabase/seed.sql`)
- Auth + memberships: `make seed-auth` (`scripts/seed-auth.ts`)
- Tenant-local negocio: `make seed-tenant` (`scripts/seed-tenant.ts`)
- Completo: `make seed-all`

## 8) Pipeline CI/CD (qué no romper)

PRs ejecutan una cadena que debe permanecer verde:

- `lint -> typecheck -> test -> migration-smoke -> build-verify`

Smoke de migraciones en PR:

```bash
make reset
make migration-apply
make generate
bun run build
bun test
```

Todo cambio de agente debe ser compatible con ese smoke.

## 9) Workflow Git para agentes

- Crear ramas desde `main`: `feat/*`, `fix/*`, `docs/*`, etc.
- Commits con Conventional Commits.
- PR siempre contra `main`.
- `develop` se usa para validación integrada (ver `CONTRIBUTING.md`).

## 10) Checklist de entrega del agente

Antes de terminar, confirmar:

1. `bun run build` pasa.
2. `bun test` pasa.
3. Docs actualizadas si cambia workflow o arquitectura.
4. No quedan referencias a comandos/archivos legacy.
5. No se editaron migraciones ya mergeadas a `main`.

## 11) Anti-patrones (NO hacer)

- No bypass de tenant en servicios tenant-local.
- No `Scope.REQUEST` en Prisma singleton.
- **No pasar `tenantId` manualmente en servicios** (usar `getTenantClient()`).
- No mezclar cambios no relacionados en el mismo PR.
- No dejar comandos de docs desactualizados con respecto a Makefile.
- No agregar lockfiles redundantes para package manager no usado.
