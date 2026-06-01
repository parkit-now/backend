# AGENTS — Parkit Backend

Documento operativo para agentes IA que trabajen sobre este repo.

## 1) Misión y prioridad

Tu objetivo es producir cambios seguros, reproducibles y alineados con arquitectura.
Prioridades:

1. No romper aislamiento multi-tenant.
2. Mantener SQL en `supabase/migrations/` como source of truth.
3. Mantener consistencia entre migraciones, schema Prisma y código Nest.
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

### Modelo de roles y permisos (scoped roles)

- **Rol global** (`users.role`, enum `user_role`): `admin | user`. `admin` ve y modifica
  todo (bypass de membership); `user` es cualquier otra persona. No existe agrupador de
  compañía: la relación es directa usuario↔entidad (`tenants`).
- **Rol por entidad** (`user_memberships.role`, enum `membership_role`): `owner | operator`.
  Acá vive si alguien es dueño u operador de un estacionamiento concreto. Un mismo `user`
  puede ser `owner` de una entidad y `operator` de otra.
- **Permisos centralizados** en `PermissionsService` (`src/auth/permissions.service.ts`):
  `isAdmin`, `canViewEntity`, `canOperateEntity`, `canManageEntity`. Único lugar con las
  reglas. Matriz: `admin`→todo; `owner`→administra su entidad (perfil, tasas, métodos de
  pago, zonas); `operator`→opera y ve, sin modificar config/tasas.
- **El JWT solo lleva `app_metadata.role`** (`admin|user`). La entidad activa NO va en el
  token: se resuelve por `/tenants/:tenantId` + `TenantMembershipGuard` (que además adjunta
  el membership y enforce `@EntityRole(...)`). Esto mantiene el modo offline del desktop:
  cambiar de entidad no re-emite token; el cliente cachea memberships (`GET /auth/me`).

## 4) Regla estricta de DTOs

### REGLA DE ARQUITECTURA: Estrategia Híbrida de DTOs (auto-generados vs. manuales)

1. **DTOs auto-generados (`prisma-generator-nestjs-dto`)**
   - Generador configurado en `prisma/schema/global/base.prisma` (output: `src/generated/nestjs-dto/`).
   - Regenerados en cada `bun install` (postinstall) y `bun run db:generate`.
   - Usar para CRUD estándar 1:1 con un modelo de DB.
   - Importar siempre desde `src/generated/nestjs-dto/` (p.ej. `CreateEntryDto`, `UpdateTenantDto`).
   - Los DTOs autogenerados se commitean (ver `EntriesController` para el patrón canónico).
   - No crear DTOs manuales para CRUD estándar.

2. **DTOs manuales (`class-validator` / `class-transformer`)**
   - Usar cuando el payload del endpoint **no mapea 1:1 a una tabla**: orquestación, agregación, validaciones que el generador no expresa, o contratos que deben ser más estrictos que lo que sale del schema.
   - Casos típicos:
     - Webhooks de hardware (LPR).
     - Integraciones de pagos (Mercado Pago).
     - Reportes/estadísticas con filtros combinados.
     - Operaciones multi-mutación sobre varias tablas.
     - Flujos de auth/recovery donde el payload mezcla campos de varias entidades o ninguna (p.ej. `{ token, password }`).
     - Endpoints donde el contrato público debe ser un subset estricto del modelo de DB (no exponer columnas internas como `status`, `ipAddress`, etc.).

Objetivo: DRY en CRUD estándar, control estricto de contratos en APIs críticas.

Aplicación en este repo (estado actual):
- CRUD de dominio debe importar desde `src/generated/nestjs-dto/`.
- DTO manual permitido solo en contratos no-CRUD. Ejemplos en el repo:
  - `src/auth/dto` (login, register, refresh, session — mezclan campos de `users` con campos que no existen en DB como `password`).
  - `src/password-recovery/dto` (forgot/reset — el payload público es un subset estricto que oculta columnas internas de `password_reset_requests` como `status`/`ipAddress`, y `ResetPasswordDto` no mapea a ninguna tabla).
  - `src/health/dto`, `src/utils/exceptions/dto`.

Cuando hay un modelo en Prisma para auditar/persistir pero el payload del endpoint es distinto, el patrón es: **DTO manual para el contrato HTTP + Prisma client autogenerado para escribir en DB**. Ver `PasswordRecoveryService` como referencia (manual `ForgotPasswordDto` en el controller, `prisma.passwordResetRequest.create(...)` en el service).

## OAuth social (Google/GitHub)

- No crear endpoints OAuth en NestJS para este alcance.
- OAuth se inicia en cliente (web/desktop) con `supabase-js`; backend solo valida JWT bearer.
- Para evitar `User not provisioned`, mantener aplicada la migración SQL de provisioning automático (`auth.users` -> `public.users` con rol global `user`).
- Config local: `supabase/config.toml` + variables `SUPABASE_AUTH_EXTERNAL_*` en `.env`.
- Config cloud: replicar providers/redirects en Supabase Dashboard.
- `make env-check` debe advertir (no bloquear) cuando falten variables OAuth locales.
- Hardening operativo:
  - mantener `enable_manual_linking = false`;
  - revisar política de verificación de email/proveedor antes de prod.

## Contrato de errores HTTP (codes estables)

Toda respuesta de error sigue Problem Details (RFC 7807) extendido con un campo
`code` estable. Los clientes hacen lookup en español por ese `code`; NO leen el
campo `detail` para el usuario (queda en ingles, solo para logs).

### Catalogo

- Fuente unica: `src/utils/exceptions/error-codes.ts`.
- Formato: `SCREAMING_SNAKE_CASE`, con prefijo por dominio (`AUTH_`, `DB_`, etc).
- Reglas:
  - Nunca renombrar un code ya publicado. Si cambia la semantica, agregar uno
    nuevo y deprecar el viejo.
  - Al agregar codes nuevos, actualizar tambien `CODE_MESSAGES` en los 3
    frontends (`front-{web,desktop,mobile}/src/lib/api/translate.ts`).

### Como emitirlos

- Para errores propios: `throw new FormattedException(title, status, detail, instance, code)`.
  El parametro `code` es `ErrorCode` (typesafe contra el catalogo).
- Validation pipe ya inyecta automaticamente:
  - `code = VALIDATION_FAILED` en el ProblemDetails externo.
  - `code = <constraint name de class-validator>` (`isEmail`, `minLength`, etc.)
    en cada `ValidationFieldErrorDto`. Hay tabla de prioridad en
    `main.ts::CONSTRAINT_PRIORITY` para elegir un constraint relevante cuando
    multiples fallan (ej. `isNotEmpty` antes que `maxLength`).
- Errores Prisma se mapean automaticamente a `DB_*` en el filter
  (`prismaCodeToErrorCode`).
- Para `HttpException` plana de Nest (sin code), el filter aplica
  `defaultCodeForStatus(status)` como red de seguridad. Aun asi, preferir
  siempre `FormattedException` para tener control explicito.

### Smoke

```bash
curl -X POST localhost:3000/auth/login -d '{}' -H "Content-Type: application/json"
# -> { "code": "VALIDATION_FAILED", "validationsErrors": [{ "code": "isEmail", ... }] }
```

### Anti-patrones

- No `throw new UnauthorizedException(...)` ni `BadRequestException(...)` cuando
  quieras un code especifico: usar `FormattedException`.
- No reutilizar un mismo code para casos semanticamente distintos.
- No incluir el code dentro de `detail` o `title` (son campos independientes).

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

- Crear ramas desde `develop`: `feat/*`, `fix/*`, `docs/*`, etc.
- Commits con Conventional Commits.
- PR siempre contra `develop`.
- `main` es producción: nunca commitear ni mergear directo a `main` (ver `CONTRIBUTING.md`).

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
