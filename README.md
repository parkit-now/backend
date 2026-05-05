# Parkit — Backend

> API HTTP del proyecto Parkit.

## Descripción

Backend del sistema Parkit (gestión de estacionamientos, LPR, reservas). Expone los endpoints HTTP que consumen la web de gestión, la app móvil y los nodos LPR. La autenticación está delegada a Supabase Auth; este servicio verifica el JWT, aplica autorización por rol y aísla por tenant.

## Stack

- **Lenguaje:** TypeScript
- **Runtime + package manager:** Bun
- **Framework:** NestJS 11
- **Base de datos:** PostgreSQL 17 (vía Supabase)
- **ORM:** Prisma 7
- **Auth:** Supabase Auth (JWT verificado vía JWKS)

## Requisitos previos

- [Docker](https://docs.docker.com/engine/install/) corriendo
- [Bun](https://bun.sh/) y [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) — `make install` los baja si no los tenés.

## Instalación

```bash
# 1. Clonar
git clone git@github.com:parkit-now/backend.git
cd backend

# 2. Levantar todo (instala deps si faltan + Supabase + migraciones + cliente Prisma)
make up

# 3. Variables de entorno
cp .env.example .env
# Pegar los valores que imprime: supabase status -o json
# (SUPABASE_*, JWT_SECRET)

# 4. Cargar datos de demo (solo local)
make seed
```

## Comandos `make`

`make help` lista todos los targets con su descripción. Resumen:

### Setup

| Target          | Qué hace                                                                                          |
|-----------------|---------------------------------------------------------------------------------------------------|
| `make help`     | Imprime el menú con todos los targets agrupados por sección.                                      |
| `make install`  | Verifica Docker. Si faltan, instala Bun y Supabase CLI. Después corre `bun install`. Idempotente. |

### Stack local

| Target          | Qué hace                                                                                                                  |
|-----------------|---------------------------------------------------------------------------------------------------------------------------|
| `make up`       | `install` + `supabase start` + aplica migraciones nuevas (`supabase migration up`) + regenera cliente Prisma. **Preserva data.** Es el "all-in-one" diario. |
| `make down`     | `supabase stop`. La data persiste en el volumen Docker.                                                                   |
| `make reset`    | `supabase db reset`: borra la DB local, re-aplica todas las migraciones desde cero y corre `supabase/seed.sql`. Útil cuando quedó inconsistente.    |
| `make seed`     | Carga usuarios de demo en Supabase Auth + filas en `public.users`. **Solo local** — aborta si `SUPABASE_URL` no es localhost. Idempotente.         |
| `make status`   | `supabase status` con todas las URLs y keys del stack local.                                                              |
| `make studio`   | Abre Supabase Studio en el navegador (<http://localhost:54323>).                                                          |
| `make logs`     | Tail -f a los logs de los contenedores Supabase.                                                                          |

### Run

| Target          | Qué hace                                                                                                  |
|-----------------|-----------------------------------------------------------------------------------------------------------|
| `make dev`      | Levanta la API en hot reload (`bun --hot`). Asume que ya corriste `make up`.                              |
| `make build`    | `nest build` → emite `dist/`.                                                                             |
| `make prod`     | `make build` + `bun run dist/main.js`. Para correr el bundle compilado localmente, no para deploy real.   |

### Calidad

| Target          | Qué hace                  |
|-----------------|---------------------------|
| `make test`     | `bun test`.               |
| `make lint`     | ESLint con auto-fix.      |
| `make format`   | Prettier sobre `src/`.    |

### Migraciones

El SQL en `supabase/migrations/` es la fuente de verdad. Prisma genera el cliente a partir de eso, no al revés.

| Target                          | Dónde corre   | Qué hace                                                                                                                                            |
|---------------------------------|---------------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| `make migration NAME=<nombre>`  | Local         | `supabase migration new <nombre>`: crea el archivo SQL vacío en `supabase/migrations/`. Editás el SQL + el `.prisma`, después aplicás.              |
| `make migration-apply`          | Local         | `supabase migration up --local` + `bun run db:generate`. Aplica las migraciones pendientes (las tuyas o las de un compañero) y regenera el cliente Prisma. **Preserva data.** |
| `make generate`                 | Local         | Sólo regenera el cliente Prisma desde el schema. No toca la DB.                                                                                     |
| `make reset`                    | Local         | `supabase db reset` + corre `seed.sql` + `db:generate`. **Borra data local.** Para volver a un estado limpio cuando algo quedó inconsistente.       |
| `make push`                     | Cloud (prod)  | `supabase db push --linked`: aplica al proyecto cloud sólo las migraciones que aún no están aplicadas. **No destructivo.** Lo normal es que esto lo corra CI/CD. |

Para la política de migraciones (append-only, flujo dev → PR → prod, reglas para no romper prod), ver [CONTRIBUTING.md § Migraciones de base de datos](./CONTRIBUTING.md#migraciones-de-base-de-datos).

### Utilidades

| Target          | Qué hace                                                |
|-----------------|---------------------------------------------------------|
| `make clean`    | Borra `dist/` y `node_modules/`.                        |

## URLs

Con `make up` + `make dev` corriendo:

| Servicio                 | URL                              |
|--------------------------|----------------------------------|
| API                      | http://localhost:3000            |
| Swagger UI               | http://localhost:3000/api        |
| Swagger JSON             | http://localhost:3000/api-json   |
| Supabase Studio          | http://localhost:54323           |
| Mailpit (mails de auth)  | http://localhost:54324           |

## Estructura del proyecto

```
.
├── prisma/schema/        Prisma schema dividido por dominio
├── prisma.config.ts      Conexión Prisma 7 (DIRECT_URL para migrate)
├── supabase/
│   ├── config.toml
│   ├── migrations/       SQL (fuente de verdad)
│   └── seed.sql          Datos de demo (solo local — corre con `make reset`)
├── scripts/
│   └── seed.ts           Seed de Supabase Auth (corre con `make seed`)
├── src/
│   ├── auth/             Verificación JWT Supabase + RolesGuard
│   ├── database/         PrismaService + prismaForTenant()
│   ├── <domain>/         Módulos por dominio (users, parkings, reservations, etc)
│   └── utils/exceptions/ Filtro RFC 7807
├── Makefile              Workflow del proyecto
└── Dockerfile            Imagen de producción (Bun)
```

## Contribuir

Ver [CONTRIBUTING.md](./CONTRIBUTING.md) para la estrategia de ramas (GitFlow simplificado), convenciones de commits y política de Pull Requests.

## Equipo

Proyecto desarrollado por el equipo Parkit (TPP — FIUBA).
