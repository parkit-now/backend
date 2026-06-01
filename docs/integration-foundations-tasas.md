# Integración `feat/foundations` + `tabla-tasas`

Informe de análisis y resolución del merge de ambas ramas sobre la rama de
integración `feat/integration`, más las recomendaciones de arquitectura (JWT y
modo offline) pedidas en el ticket.

> Contexto previo: antes del merge se eliminó del backend la capa **Company**.
> Ahora la relación es directa **usuario↔entidad (tenant)**: un owner es owner de
> varias entidades y un operator opera varias entidades, vía `UserMembership` +
> el `role` global del usuario. No hay agrupador de compañía. Ese refactor vive
> en `feat/foundations` (commits `refactor(...)`) y es la base del merge.

---

## 1. Resumen ejecutivo

- `tabla-tasas` agrega la entidad **`Rate`** (tarifas, tenant-local) y su CRUD bajo
  `/tenants/:tenantId/rates`. **No toca la capa company**, así que el merge es
  limpio salvo por puntos donde ambas ramas tocan los mismos archivos.
- El **único conflicto de diseño real es el JWT**: las dos ramas inyectan el
  `role` por mecanismos distintos. Se resolvió quedándose con el de
  `feat/foundations` (hook de Postgres) y descartando el de `tabla-tasas`
  (`syncRoleClaim` en NestJS), que es redundante e inferior.
- El resto de conflictos son uniones triviales (registros de módulo, lista de
  modelos tenant-local, relaciones de schema, deps).
- Resultado: `bun run build` OK, `bun test` 48/48, las 11 migraciones aplican en
  orden, y el JWT emitido lleva solo `app_metadata.role` (sin entidad).

---

## 2. Conflictos detectados y resolución

| # | Archivo | Conflicto | Resolución |
|---|---------|-----------|------------|
| 1 | `src/auth/supabase-auth.service.ts` | `tabla-tasas` agrega `syncRoleClaim()` + `refreshSession()` en el login para sincronizar `app_metadata.role` desde NestJS | **Descartado.** El hook SQL de foundations ya inyecta el `role` fresco en **cada** mint del token (incluye OAuth) sin round-trips. Se eliminó `syncRoleClaim` y el refresh manual; `signInWithPassword` vuelve a `return toSessionDto(session)`. |
| 2 | `prisma/schema/global/tenants.prisma` | Ambas agregan relaciones a `Tenant` | **Unión.** Quedan `memberships, entries, zones, rates, paymentMethods, auditLogs, applications` (sin `company`). |
| 3 | `src/database/prisma-tenant.ts` | `TENANT_MODELS`: foundations agrega `zone`, tasas agrega `rate` | **Unión:** `['entry', 'zone', 'rate']`. |
| 4 | `src/app.module.ts` | Ambas registran módulos nuevos | **Unión:** `ZonesModule, OnboardingModule, ApplicationsModule, EntitiesModule, RatesModule`. |
| 5 | `src/generated/nestjs-dto/tenant.entity.ts` | DTO autogenerado divergente | **Regenerado** con `make generate` tras resolver el schema (no se mergea a mano; política del repo). |
| — | `package.json` / `tsconfig.json` | `tabla-tasas` agrega deps/paths | Auto-merge (unión), sin intervención. |
| — | `supabase/migrations/` | Cada rama agrega sus migraciones | Sin solapamiento de tablas. Orden por timestamp: `add_rates` (20260529) → `add_onboarding` (20260531) → `add_zones` → `add_role_access_token_hook` (20260601). `rates` solo depende de `tenants` (preexistente), así que aplica primero sin problema. |

### Detalle del conflicto JWT (el importante)

- **foundations** — `supabase/migrations/20260601004947_add_role_access_token_hook.sql`
  define `public.custom_access_token_hook(event jsonb)`, habilitado en
  `supabase/config.toml` (`[auth.hook.custom_access_token] enabled = true`). Lee
  `public.users.role` y escribe `claims.app_metadata.role` en **cada emisión** de
  token, para email/password **y OAuth**.
- **tabla-tasas** — en `signInWithPassword()` comparaba el `role` del JWT contra
  la DB y, si difería, hacía `updateUserById` + `refreshSession`. Esto: (a) solo
  corre en el login por password (no cubre OAuth), (b) agrega un round-trip extra,
  (c) duplica la responsabilidad del hook.
- **Decisión:** el hook es estrictamente superior → se mantiene foundations y se
  elimina `syncRoleClaim`. Un único mecanismo, una única fuente de verdad
  (`public.users.role`).

---

## 3. Problemas de arquitectura / permisos detectados

1. **Permisos de tarifas (verificado, correcto).** `RatesController` usa
   `JwtAuthGuard + TenantMembershipGuard + RolesGuard`:
   - `GET /tenants/:id/rates` y `GET .../rates/changes`: sin `@Roles` → cualquier
     miembro del tenant (incluye **operator**) puede **leer**.
   - `POST/PATCH/DELETE`: `@Roles(owner, admin)` → el operador recibe **403**.
   Coincide exactamente con el requisito (operador ve tarifas, no las modifica;
   admin y owner de la entidad las administran).

2. **Doble módulo de tenant.** Conviven `TenantsModule` (preexistente) y el nuevo
   `EntitiesModule` (perfil/pagos/auditoría bajo `/tenants/:id`). No hay colisión
   de rutas hoy, pero **se sugiere** consolidar ambos en un único módulo de
   entidad para evitar divergencia futura. (No bloqueante.)

3. **`cuit` dejó de ser único.** Antes era único a nivel Company. Al aplanar a
   entidad, se decidió `cuit` como atributo **no único** del tenant: una misma
   persona jurídica puede tener varias entidades (sucursales) con el mismo CUIT.
   Si el negocio exige unicidad por CUIT, hay que reintroducir una validación
   explícita (no un índice único).

4. **Autorización offline (operadores).** `TenantMembershipGuard` valida el
   membership contra la DB en cada request. **Esto no funciona offline** (no hay
   server). Ver §5: la app desktop debe autorizar localmente con datos cacheados,
   y el server re-valida al sincronizar.

5. **`ONBOARDING_NOT_SUBMITTABLE` quedó sin uso** tras pasar a "una entidad por
   application" (antes exigía ≥1 sucursal declarada). Se dejó en el catálogo
   (no se renombra/borra un code para no romper el contrato), pero conviene
   revisarlo.

---

## 4. Recomendaciones de JWT y permisos

- **Un solo claim de identidad/rol en el token:** `app_metadata.role`, inyectado
  por el hook de Postgres. La DB es la fuente de verdad; el claim solo la
  espeja para que el cliente rutee sin pegarle a `/users/me`.
- **La entidad activa NO va en el JWT.** Se resuelve por request desde
  `/tenants/:tenantId` + `TenantMembershipGuard` (admin = bypass; resto = exige
  membership). La entidad "seleccionada" es **estado local del cliente**.
  - *Por qué no meterla en el token (descarta la propuesta original):* obligaría a
    **re-emitir el token** al cambiar de entidad (operación online → rompe
    offline), genera tokens desincronizados si cambian permisos, y agranda el
    token sin beneficio (la autorización igual se valida contra la DB).
- **Escrituras sensibles** (tarifas, configuración de la entidad) siempre con
  `@Roles(owner, admin)` además del membership guard. Defensa en profundidad:
  guard de app + RLS en DB.
- **Rotación de refresh token** ya activa (`enable_refresh_token_rotation = true`,
  `refresh_token_reuse_interval = 10`). Mantener.

---

## 5. Recomendaciones para soporte offline (app desktop)

El requisito: tras login exitoso, el operador opera **sin conexión** por períodos
prolongados, y al reconectar se sincronizan los cambios. El server sigue siendo
la fuente de verdad.

1. **Sesión de larga duración.** El access token dura 1 h (`jwt_expiry = 3600`),
   pero el refresh token no tiene timebox configurado (vida larga). La desktop
   debe **cachear access + refresh token** en un store local seguro (p.ej.
   keychain del SO / archivo cifrado). Mientras está offline **no** se valida el
   `exp` contra el server (no hay a quién preguntar): se confía en la identidad
   cacheada durante la ventana offline. Al reconectar, `refreshSession()` y se
   sigue.
   - *Opcional:* subir `jwt_expiry` (máx 1 semana) si se quiere una ventana de
     confianza más larga sin depender del refresh.

2. **Autorización local.** La desktop **cachea `role` + sus `memberships`**
   (entidades a las que el usuario tiene acceso) mientras hay red, igual que
   cachea las tarifas. Offline autoriza con esa copia; el server re-valida en
   cada sync (si un admin revocó acceso mientras estaba offline, el push se
   rechaza). Esto cubre el hueco del `TenantMembershipGuard` señalado en §3.4.

3. **Mutaciones offline → patrón outbox / event-log.** `Rate` ya trae las piezas
   para sync incremental: `syncSeq` (secuencia incremental), `version`
   (optimistic locking), `deletedAt` (soft delete) y el endpoint
   `GET /tenants/:id/rates/changes`. Se recomienda **extender el mismo patrón a
   los eventos de ingreso/egreso** (la operación core del operador):
   - IDs generados en el cliente (UUIDv7) para idempotencia.
   - Cola local de eventos; push al reconectar; el server asigna el orden
     autoritativo.
   - Los eventos de entrada/salida son **append-only** → no hay conflictos de
     merge.
   - Tarifas: el operador **solo lee** (sin conflicto). El owner las edita online
     con optimistic locking por `version`.

4. **Seguridad bajo offline.** Aunque un cliente manipulado intente forjar una
   mutación de tarifa offline, al sincronizar el server la rechaza: el endpoint
   de escritura exige `owner|admin` (RolesGuard) y membership. La trazabilidad se
   mantiene porque todos los eventos llegan finalmente al server.

---

## 6. Cambios aplicados antes/durante el merge

- **Antes del merge (en `feat/foundations`):** eliminación de la capa Company,
  reubicación de datos legales/contacto y payment methods a `Tenant`, onboarding
  re-escopado a una entidad por application (`applicantUserId` + `declaredEntity`,
  `ApplicationDocument`), `approve()` materializa el tenant + membership owner +
  zona + payment methods + promoción driver→owner, baja de `CompanyOwnerGuard` /
  `ScopedCompany` / `setActiveTenant`, codes `COMPANY_*` → `ENTITY_*`.
- **Durante el merge (en `feat/integration`):** resolución de los 5 conflictos
  (§2), eliminación de `syncRoleClaim`, regeneración de DTOs.

### Pendientes sugeridos (no bloqueantes)
- Consolidar `TenantsModule` + `EntitiesModule` (§3.2).
- Definir si `cuit` requiere unicidad por validación (§3.3).
- Implementar el cache local + outbox en la desktop (§5) — trabajo de front.
- Actualizar `translate.ts` en `front-{web,desktop,mobile}` por el renombre de
  codes `COMPANY_*`→`ENTITY_*` (contrato de errores, AGENTS.md).
- Revisar `ONBOARDING_NOT_SUBMITTABLE` sin uso (§3.5).

---

## 7. Verificación

```bash
make reset && make migration-apply && make generate   # 11 migraciones aplican OK
bun run build                                          # OK
bun test                                               # 48 pass / 0 fail
make seed-all                                          # entidades + memberships + application pending
```

- JWT tras login (`owner@once.test`): `app_metadata.role = "owner"`, **sin**
  `tenant_id` ni `company_id`.
- Permisos de tarifas (estático, por guards): operador lee `GET`, recibe 403 en
  `POST/PATCH/DELETE`; owner/admin administran.
- Sin referencias a `company`/`companyId` en `src/` (excluyendo nada — limpio).
