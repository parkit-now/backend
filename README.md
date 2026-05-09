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

```bash
make down
make status
make studio
make logs
```

## 4) Multi-tenencia Automática (Aislamiento de Datos)

Este proyecto utiliza un sistema de multi-tenencia automatizado mediante `AsyncLocalStorage` y extensiones de Prisma.

- **Aislamiento por Request**: El `tenantId` se captura automáticamente de la URL mediante un `TenantInterceptor`.
- **Acceso Blindado**: En los servicios, se debe usar siempre `this.prisma.getTenantClient()` para operar sobre modelos locales. Esto garantiza que las queries estén filtradas por el tenant activo sin pasarlo por parámetro.
- **Seguridad**: El `TenantMembershipGuard` valida que el usuario autenticado pertenezca realmente al tenant solicitado.

## OAuth social (Google/GitHub)

### Principio de arquitectura

- El backend **no agrega endpoints OAuth**.
- Web/Desktop inicia OAuth directo con Supabase (`supabase-js`).
- La API sigue validando JWT con `SupabaseJwtService` (agnóstico al proveedor).

### Setup local

1. Completar en `.env`:
   - `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID`
   - `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`
   - `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID`
   - `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET`
2. Configurar callbacks en Google/GitHub OAuth App:
   - Callback Supabase local: `http://127.0.0.1:54321/auth/v1/callback`
3. Redirects de app permitidos (ya definidos en `supabase/config.toml`):
   - `http://127.0.0.1:3000`
   - `http://localhost:3000`
   - `parkit://auth/callback` (desktop)
4. Reiniciar Supabase local para tomar cambios:

```bash
make down
make up
```

### Producción (Dashboard Supabase)

- Replicar Google/GitHub providers en **Authentication > Providers**.
- Cargar client ID/secret de cada proveedor.
- Declarar los redirect URLs exactos de tus apps web y desktop.

### Troubleshooting rápido

- Si faltan variables OAuth, `make env-check` muestra warning y el resto del stack sigue funcionando.
- El primer login social requiere internet; modo offline usa sesión ya emitida/caché local del cliente.
- Si el usuario social autentica pero API responde `User not provisioned`, revisar que la migración del trigger esté aplicada.

### Checklist de hardening (operativo)

- Verificar en Supabase que `enable_manual_linking = false` (evita linking manual inseguro).
- Revisar política de verificación de email/proveedor en Dashboard antes de habilitar signup abierto en prod.
- Mantener rol inicial de auto-provisioning en `driver` (mínimo privilegio).

## 5) Seeds

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

## 9) Git workflow (GitFlow Simplificado)

El equipo utiliza una versión simplificada de GitFlow para mantener la velocidad y la calidad.

### 1. Crear rama de Feature
Siempre partir de la última versión de `main`.
```bash
git switch main
git pull origin main
git switch -c feat/descripcion-corta
```

### 2. Commits & Push
Usar Conventional Commits (`feat:`, `fix:`, `docs:`, etc.).
```bash
git add .
git commit -m "feat: implementar aislamiento de tenant"
git push -u origin feat/descripcion-corta
```

### 3. Pull Request (PR)
- Abrir el PR contra `main`.
- Validar en el entorno de `develop` (Staging) si es necesario.
- Requiere al menos 1 aprobación y CI en verde.
- Usar **Squash & Merge** al finalizar.

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
