# Guía de Arquitectura: Agregar Modelos en una DB Única (Global + Tenant)

Este backend usa **una sola base PostgreSQL/Supabase** con dos capas lógicas:

1. **Global**: datos compartidos por toda la plataforma (`users`, `tenants`, `vehicles`, etc).
2. **Tenant-local**: datos de negocio aislados por tenant (`entries` y futuros módulos operativos).

La estrategia es de defensa en profundidad:

- Aislamiento en aplicación (`prismaForTenant(...)`, validaciones de membership, coherencia de tenant activo).
- Aislamiento en base (RLS + policies SQL).

`supabase/migrations` es la fuente de verdad del schema SQL.

---

## Flujo oficial para agregar un modelo

Orden recomendado (siempre igual):

1. **Crear migración SQL**
2. **Reflejar schema en Prisma (`prisma/schema/**`)**
3. **Generar cliente + DTOs**
4. **Wirear módulo/servicio/controlador**
5. **Aplicar seguridad tenant (si corresponde)**
6. **Agregar/actualizar tests**

Comandos base:

```bash
make migration NAME=add_<modelo>
# editar SQL en supabase/migrations/<timestamp>_add_<modelo>.sql

make migration-apply
make generate
bun run build
bun test
```

---

## 1) Modelo Global

Un modelo global **no** depende de `tenant_id`.

### Prisma schema

Crear/editar en `prisma/schema/global/`.

Ejemplo (`Vehicle`):

```prisma
model Vehicle {
  id        String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  brand     String
  model     String
  type      String?
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  entries   Entry[]

  @@map("vehicles")
}
```

### Servicio/controlador

- En módulo Nest: importar `PrismaModule`.
- En servicio: acceso directo con `this.prisma.<model>`.

```ts
@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  create(data: CreateVehicleDto) {
    return this.prisma.vehicle.create({ data });
  }
}
```

---

## 2) Modelo Tenant-local

Un modelo tenant-local **debe** quedar aislado entre tenants.

### Prisma schema

Crear/editar en `prisma/schema/tenant/` y relacionar con `Tenant`.

```prisma
model Entry {
  id         String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  plate      String    @db.VarChar(10)
  color      String?   @db.VarChar(50)
  enteredAt  DateTime  @default(now()) @map("entered_at")
  leftAt     DateTime? @map("left_at")
  amountPaid Decimal?  @map("amount_paid") @db.Decimal(10, 2)

  vehicleId  String    @map("vehicle_id") @db.Uuid
  vehicle    Vehicle   @relation(fields: [vehicleId], references: [id])

  tenantId   String    @map("tenant_id") @db.Uuid
  tenant     Tenant    @relation(fields: [tenantId], references: [id])

  @@map("entries")
}
```

Si agregas una relación a `Tenant`, no olvides la inversa en `prisma/schema/global/tenants.prisma`.

### Servicio/controlador

- No usar `this.prisma.<model>` directo.
- Usar `prismaForTenant(this.prisma, tenantId)`.
- El endpoint debe estar tenant-scoped (`/tenants/:tenantId/...`).

```ts
const tenantPrisma = prismaForTenant(this.prisma, tenantId);
return tenantPrisma.entry.findMany();
```

---

## 3) Seguridad Tenant (obligatoria para modelos locales)

Checklist mínimo:

1. SQL con columna `tenant_id` + FK.
2. Modelo registrado en `TENANT_MODELS` (`src/database/prisma-tenant.ts`).
3. Validar membership del usuario sobre ese tenant en la capa de negocio.
4. Validar coherencia tenant de request:
   - `tenantId` de path,
   - tenant activo del token/claims,
   - tenant efectivo en contexto de DB.
5. Crear/ajustar policies RLS de la tabla en migración SQL.

### Importante: contexto por request sin romper Prisma singleton

Para transportar claims/rol/tenant hacia la capa DB:

- **Sí** usar `AsyncLocalStorage` (ALS) o contexto explícito en `enhance(...)`.
- **No** convertir `PrismaService` a `Scope.REQUEST`.

`Scope.REQUEST` en Prisma crea una instancia por request y puede agotar conexiones.

---

## 4) DTOs: generados vs manuales

### REGLA DE ARQUITECTURA: Estrategia Híbrida de DTOs (ZenStack vs. Manuales)

Al generar controladores o servicios en NestJS, el asistente de IA **DEBE** respetar la siguiente división de responsabilidades para los DTOs:

1. **Uso de DTOs Auto-generados (ZenStack):**
   - **Cuándo:** Para operaciones CRUD estándar (ABM básico) que mapean 1:1 con el modelo de la base de datos (ej. actualizar el nombre de un operario, crear una tarifa base).
   - **Cómo:** Importar y utilizar directamente los tipos y DTOs que ZenStack genera a partir del archivo `.zmodel`. **NO** crear archivos DTO manuales para esto.

2. **Uso de DTOs Manuales (`class-validator` / `class-transformer`):**
   - **Cuándo:** Para endpoints orquestadores o que involucran lógica de negocio compleja que no mapea directamente con una tabla.
   - **Casos de uso obligatorios:**
     - Webhooks de hardware externo (ej. payloads crudos de las cámaras LPR).
     - Integraciones con pasarelas de pago (ej. notificaciones de Mercado Pago).
     - Endpoints de estadísticas o reportes con filtros combinados.
     - Operaciones que disparan múltiples mutaciones en diferentes tablas a la vez.
   - **Cómo:** Crear el archivo `*.dto.ts` correspondiente y utilizar los decoradores de validación clásicos de NestJS.

**Objetivo:** Mantener el código DRY apoyándonos en ZenStack para lo aburrido, pero conservar el control estricto de los contratos de entrada para las APIs críticas del negocio.

---

## 5) Seeds de desarrollo (una base, dos capas lógicas)

### Global seed (SQL)

Archivo: `supabase/seed.sql`

Incluye datos globales (tenants + catálogo global de ejemplo). Es idempotente y corre en `make reset`.

```bash
make seed-global
```

### Auth/membership seed

Script: `scripts/seed-auth.ts`

- Crea usuarios demo en Supabase Auth.
- Sincroniza `public.users` + `user_memberships`.
- Solo local (guardrail por `SUPABASE_URL`).

```bash
make seed-auth
```

### Tenant-local business seed

Script: `scripts/seed-tenant.ts`

- Crea `entries` de ejemplo separadas por tenant.
- Reutiliza `vehicles` globales.
- Solo local (guardrail por `SUPABASE_URL`).

```bash
make seed-tenant
```

### Seed completo

```bash
make seed-all
```

---

## 6) Smoke checklist antes de abrir PR

```bash
make reset
make migration-apply
make generate
bun run build
bun test
```

Si algo falla acá, el PR no debería abrirse todavía.

---

## Cheat Sheet rápido

| Tema | Modelo Global | Modelo Tenant-local |
|---|---|---|
| Ubicación Prisma | `prisma/schema/global/` | `prisma/schema/tenant/` |
| `tenant_id` | No | Sí |
| `TENANT_MODELS` | No | Sí |
| Acceso en servicio | `this.prisma.model` | `prismaForTenant(this.prisma, tenantId).model` |
| Endpoint típico | `/vehicles` | `/tenants/:tenantId/entries` |
| RLS específica | Opcional según caso | Obligatoria |
