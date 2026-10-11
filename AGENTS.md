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
  - Global (`users`, `tenants`, `vehicle_type_defaults`, `vehicle_catalog_defaults`, etc)
  - Tenant-local (`entries`, `rates`, `vehicles`, `vehicle_types` y futuros módulos operativos)
- Defensa en profundidad:
  - Capa app (`getTenantClient()`, validaciones de membership/tenant automáticas vía Guards/Interceptors)
  - Capa DB (RLS + policies SQL)
- Migraciones SQL son append-only en prod (no editar archivos ya mergeados a `main`).

### Arquitectura offline-first del desktop

El cliente desktop opera con IndexedDB local (Dexie.js) como fuente de verdad en runtime. El backend expone endpoints de **sync incremental** basados en `syncSeq`:

```
GET /tenants/:tenantId/<modelo>/changes?afterSeq=N
→ { items: ModelDto[], maxSeq: number }
```

El desktop hace `pull` al reconectar y hace `push` de mutaciones encoladas mientras estuvo offline.

**Campos obligatorios en modelos syncables** (tenant-local):

- `syncSeq INTEGER DEFAULT nextval('<modelo>_sync_seq')` — asignado en INSERT por DEFAULT, incrementado en UPDATE por trigger
- `version INTEGER DEFAULT 1` — optimistic locking; se incrementa en cada UPDATE
- `updated_at TIMESTAMPTZ DEFAULT now()` — actualizado por trigger en UPDATE

**Campos obligatorios en modelos con UUID cliente** (global + tenant-local):

- Eliminar `@default(dbgenerated("gen_random_uuid()"))` del campo `id` en Prisma para que el cliente provea UUIDv7 generado localmente.

Ver `supabase/migrations/20260529093000_add_rates.sql` y `20260603225951_entries_offline_sync.sql` como referencia del patrón completo.

### Cómo nace un tenant

Hay **tres** caminos de creación de estacionamientos:

| Camino                  | Archivo                                          |
| ----------------------- | ------------------------------------------------ |
| Aprobación de solicitud | `src/admin/applications/applications.service.ts` |
| Alta directa del admin  | `src/admin/parkings/parkings.service.ts`         |
| Seed local              | `supabase/seed.sql`                              |

Los tres convergen en el trigger `AFTER INSERT ON tenants`
(`bootstrap_tenant_defaults()`, migración `20260901013345`), que siembra los
siete tipos de vehículo, el catálogo de modelos completo (ver §7.1), el servicio
de reserva anticipada y los dos métodos de pago del sistema.

**Si hay que agregar un default nuevo, va en el trigger y en ningún otro lado.**
Antes esto se hacía a mano en `approve()` y el alta directa del admin se lo
olvidaba: un estacionamiento creado desde el panel nacía sin servicios y sin
métodos de pago. "Acordate de llamarlo en cada lugar" ya falló una vez acá.

Precedente del patrón: `20260507042000_oauth_auto_provision_users.sql`.

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

- CRUD de dominio estándar importa desde `src/generated/nestjs-dto/`.
- DTO manual cuando el contrato HTTP no es 1:1 con la tabla. Ejemplos vigentes:
  - `src/rates/dto/` — El `CreateRateDto` acepta `id` provisto por cliente (UUIDv7 offline), `pullChanges` retorna `RateChangesResponseDto` que agrega `maxSeq`. Ninguno de estos mapea 1:1 al modelo.
  - `src/entries/dto/` — `CreateEntryDto` incluye `id` cliente + campos de snapshot de tarifa que no están en el modelo como escritura directa. `CloseEntryDto` es un subset con lógica de negocio (defaultea `leftAt` a `now()` si no se envía).
  - `src/vehicles/dto/` y `src/vehicle-types/dto/` — `id` provisto por el
    cliente (UUIDv7 offline), `expectedVersion` para el optimistic locking, y
    `pullChanges` que agrega `maxSeq`. El listado de tipos agrega además
    `vehicleCount`, que no existe como columna.
  - `src/auth/dto`, `src/password-recovery/dto`, `src/health/dto`, `src/utils/exceptions/dto`.

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
4. Verificar que el orden sea aplicable:

```bash
make migration-check
```

> **Por qué importa el orden**: `supabase db push` aplica en orden de nombre y
> rechaza cualquier migración con timestamp anterior a la última ya aplicada.
> Si se mergea una así, el deploy a producción se bloquea hasta que alguien
> corra `--include-all`, que la aplica **fuera de orden**. Ya pasó: producción
> quedó 5 migraciones atrás y el backend desplegado devolvía 404 porque Prisma
> pedía columnas que la base no tenía. El chequeo corre solo en el pre-commit y
> en el job `Migrations` del CI.

5. Aplicar/regen:

```bash
make migration-apply
make generate
```

> **Workaround Node 18**: Prisma 7.8.0 requiere Node ≥ 20. Si el sistema tiene Node 18 (sistema),
> `make migration-apply` aplica la migración SQL correctamente pero falla en el paso `prisma generate`.
> Solución: regenerar manualmente con nvm:
>
> ```bash
> PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH" bun run db:generate
> ```

6. Validar:

```bash
bun run build
bun test
```

## 7) Seeds oficiales de desarrollo

- Global SQL: `make seed-global` (`supabase/seed.sql`)
- Auth + memberships: `make seed-auth` (`scripts/seed-auth.ts`)
- Tenant-local negocio: `make seed-tenant` (`scripts/seed-tenant.ts`)
- Completo: `make seed-all`

### 7.1) Catálogo de vehículos (NO es un seed)

`vehicle_catalog_defaults` es la plantilla desde la que cada tenant recibe su
copia editable de modelos. **Vive en migraciones, no en `seed.sql`**: `seed.sql`
es local-only y `supabase db push` nunca lo aplica, así que producción nacería
sin catálogo.

| Comando                 | Qué hace                                                |
| ----------------------- | ------------------------------------------------------- |
| `make catalog-import`   | Importa el catálogo de thecarsbase. **Único script del repo que toca la red.** ~20 min. Acepta `LIMIT=20` |
| `make catalog-sql`      | Emite a stdout el SQL de la plantilla. Puro              |
| `make catalog-migration`| Escribe la migración completa (plantilla + backfill)     |

```
scripts/import-vehicle-catalog.ts   (red)
        ↓
scripts/data/vehicle-catalog.json   (importado, versionado)
        +  scripts/data/vehicle-brands.ts   (curado)
        +  scripts/data/vehicle-types.ts    (overrides + mapeo de carrocerías)
        ↓
scripts/gen-vehicle-catalog.ts      (puro: merge + guards)
        ↓
supabase/migrations/<ts>_backfill_vehicle_catalog.sql
```

Reglas:

- **El catálogo final es la UNIÓN, no el import.** Lo curado gana en nombre y en
  tipo. Hay modelos que se venden mucho acá y la fuente no tiene (T-Cross, Great
  Wall, Lifan): reemplazar en vez de unir los borraría.
- **No hay default en ningún paso.** Un modelo sin tipo o una carrocería sin
  mapear hacen fallar al generador con la lista. Los globales son read-only para
  el tenant: un modelo mal tipificado en silencio no lo puede corregir nadie
  desde la app.
- **Nunca un UPDATE masivo sobre `vehicles`.** `set_vehicles_sync_fields` es un
  `BEFORE UPDATE` que bumpea `sync_seq` **y** `version`, así que invalidaría las
  `version` cacheadas de todos los clientes offline. El backfill es un INSERT.
- El backfill a tenants existentes lleva un `NOT EXISTS` además del
  `ON CONFLICT`: el índice único de `vehicles` es **parcial**
  (`WHERE deleted_at IS NULL`), así que sin él resucitaría los modelos que el
  dueño borró.

## 8) Pipeline CI/CD (qué no romper)

PRs y pushes a `develop`/`main` ejecutan una cadena encadenada por `needs:`
que debe permanecer verde (`.github/workflows/pipeline.yml`):

- `lint -> typecheck -> test -> build`

| Job         | Corre                                     | Por qué                                                                                      |
| ----------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `lint`      | `bun run lint:check` + `prettier --check` | `lint:check` NO lleva `--fix`: en CI auto-corregir deja el job verde escondiendo el problema |
| `typecheck` | `bun run typecheck`                       | `tsc --noEmit` sobre TODO, specs incluidos                                                   |
| `test`      | `bun test`                                | La suite mockea Prisma, no necesita base                                                     |
| `build`     | `bun run build`                           | El artefacto tiene que compilar de verdad                                                    |

Todos hacen `bun install --frozen-lockfile` primero, cuyo `postinstall` corre
`prisma generate`. **Ese paso no es opcional**: sin el cliente al día, `tsc`
tira errores fantasma del tipo "Property X does not exist on type".

Reproducir el pipeline completo en local:

```bash
bun install
bun run lint:check
bun run typecheck
bun test
bun run build
```

### Deploy a producción y migraciones

El push a `main` dispara Cloud Build con `cloudbuild.yaml`: **Build → Push →
Migrate → Deploy**. Migrate corre `supabase db push` contra prod antes de
levantar la revisión nueva; si falla, no hay deploy. Consecuencia para quien
escribe migraciones: la revisión vieja corre unos minutos contra el schema
nuevo, así que **toda migración tiene que ser compatible con el código
anterior** (aditiva; lo destructivo, con expand/contract — ver
`CONTRIBUTING.md`).

### Por qué `build` y `typecheck` corren `prisma generate`

`nest build` y `tsc` compilan contra el `@prisma/client` de `node_modules`. Si
alguien hace `git pull` con una migración nueva y no reinstala, compila contra
un cliente viejo y aparecen errores de tipo que no existen en el código. Pasó
de verdad con `lprImageRetentionDays`. Por eso ambos scripts generan primero.

### Pendiente: smoke de migraciones

El pipeline **todavía no** valida migraciones: haría falta levantar Supabase en
CI. Hasta entonces, correr a mano antes de mergear un cambio de schema:

```bash
make reset
make migration-apply
make generate
bun run build
bun test
```

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
