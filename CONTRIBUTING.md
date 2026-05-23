# Contributing

Este documento describe el flujo de trabajo Git, la convención de commits y la política de Pull Requests del proyecto **Parkit**. Es de lectura obligatoria antes de abrir tu primer PR.

## Modelo de ramas y entornos

Trabajamos con dos ramas permanentes y branches por feature/fix. La validación previa a producción ocurre en `develop`.

### Ramas permanentes

| Rama      | Entorno  | Propósito                                                                 |
| --------- | -------- | ------------------------------------------------------------------------- |
| `main`    | PROD     | Producción. Solo llegan cambios aprobados vía PR.                         |
| `develop` | STAGING  | Entorno compartido para QA/demos. Se valida acá antes de mergear a `main`. |

> `develop` (STAGING) es **compartido**: avisar antes de cambios grandes, mantenerlo ordenado y coordinar reescrituras de historia.

### Ramas temporales

| Prefijo      | Para qué sirve                           | Origen    | PR apunta a |
| ------------ | ---------------------------------------- | --------- | ----------- |
| `feat/*`     | Nuevas funcionalidades                   | `develop` | `develop`   |
| `fix/*`      | Correcciones de bugs                     | `develop` | `develop`   |
| `docs/*`     | Cambios solo de documentación            | `develop` | `develop`   |
| `chore/*`    | Tooling, dependencias, mantenimiento, CI | `develop` | `develop`   |
| `test/*`     | Tests nuevos o corrección de tests       | `develop` | `develop`   |
| `refactor/*` | Refactors sin cambios funcionales        | `develop` | `develop`   |
| `perf/*`     | Mejoras de performance                   | `develop` | `develop`   |
| `hotfix/*`   | Corrección urgente en PROD               | `main`    | `main`      |

Las ramas temporales **siempre salen de `develop` actualizado**, excepto `hotfix/*` que sale de `main`.
El flujo de promoción es: `Feature Branch` → `develop` (integración/STAGING) → `main` (PROD).
Tras mergear un `hotfix/*` a `main`, siempre backportear a `develop` para no perder el fix. 

### Convención de naming

```
<tipo>/SCRUM-XXX-descripcion-corta-en-kebab-case
```

Ejemplos:

```
feat/SCRUM-42-login-con-google
fix/SCRUM-58-error-validacion-formulario
docs/SCRUM-77-guia-instalacion
chore/SCRUM-12-bump-deps
```

- Siempre incluir la clave de JIRA (`SCRUM-XXX`).
- Descripción corta en minúsculas, separada por guiones.
- Sin acentos ni caracteres especiales.

## Conventional Commits

Todos los commits siguen [Conventional Commits 1.0](https://www.conventionalcommits.org/es/v1.0.0/):

```
<tipo>(<scope opcional>): <descripción en imperativo>

[cuerpo opcional, explicar el por qué del cambio]

[footer opcional, p. ej. Refs SCRUM-XXX]
```

### Tipos permitidos

- `feat`: nueva funcionalidad
- `fix`: corrección de bug
- `docs`: cambios de documentación
- `style`: formato (no afectan al código en sí)
- `refactor`: refactor sin cambios funcionales
- `perf`: mejoras de performance
- `test`: agregar o corregir tests
- `chore`: tareas de tooling, build, dependencias
- `ci`: cambios en pipelines / CI

### Ejemplos

```
feat(auth): agregar login con Google
fix(reservas): corregir cálculo de tarifa nocturna
docs(readme): actualizar pasos de instalación
chore(deps): bump express a 4.19.2
```

## Política de Pull Requests

1. **Features apuntan a `develop`**: Toda nueva funcionalidad se integra primero en la rama de integración.
2. **Promoción a `main`**: Una vez que `develop` es estable, se abre un PR de `develop` hacia `main` (Release).
3. **Mínimo 1 reviewer** debe aprobar antes del merge.
4. **CI obligatorio en verde:** lint y tests deben pasar. No se mergea con checks rojos.
5. **Conventional commits** en el título del PR.
6. **Referencia a JIRA** en el cuerpo del PR (`Refs SCRUM-XXX`).
7. **Squash & merge** como estrategia por defecto para Features.
7. **Borrar la rama** una vez mergeado el PR.
8. **Un PR = una rama = una tarea**: no mezclar cambios de otras ramas o tareas.

## Protección de ramas

- `main`: Protegida. Solo recibe merges de `develop` o `hotfix/*`.
- `develop`: Protegida. Recibe merges de las ramas de `feat/*` y `fix/*`.

## Flujo típico de una feature

El flujo usa **rebase** para mantener la rama siempre arriba del último `main`. Esto evita probar contra una base vieja y minimiza conflictos al abrir el PR.

### 1. Partir de `develop` actualizado

```bash
git switch develop
git pull origin develop
git switch -c feat/SCRUM-42-branch-name
```

### 2. Desarrollar y commitear

Trabajar normalmente, aplicando Conventional Commits.

```bash
git add .
git commit -m "feat(scope): descripción del cambio"
```

Pushear la rama (la primera vez con `-u`):

```bash
git push -u origin feat/SCRUM-42-branch-name
```

### 3. Validar en `develop` (STAGING)

Cuando tu feature esté lista para ser probada:
1. Abrí un PR de tu rama contra **`develop`**.
2. Una vez aprobado y mergeado, el pipeline de CI desplegará tus cambios en STAGING.
3. Validá funcionalmente en el entorno integrado.

### 4. Salida a `main` (PRODUCCIÓN)

Cuando se decide que la versión en `develop` está lista para ser productiva:
1. Abrí un PR de `develop` contra **`main`**.
2. Al mergear, el pipeline desplegará en PROD.
3. Se recomienda crear un `tag` de versión (ej: `v1.1.0`) sobre `main`.

## Casos borde

### Caso feliz

`develop` no tiene historia divergente respecto a `main`. Un `git pull --rebase` alcanza.

### Conflictos al rebasear sobre `main`

La estrategia habitual es saltear el commit conflictivo del entorno (no del feature):

```bash
git rebase --skip
```

Si los conflictos vienen del feature en sí, resolverlos manualmente y `git rebase --continue`.

### Reset controlado de `develop` (último recurso, coordinar primero)

Si develop quedó inconsistente y se acuerda con el equipo reiniciarla:

```bash
git fetch origin
git switch develop
git reset --hard origin/main
git push --force-with-lease
```

Esto borra commits que otras personas pudieran estar probando — **avisar siempre antes** en el canal del equipo.

## Migraciones de base de datos

**Las migraciones son append-only e inmutables en producción.** Una vez que un archivo está mergeado a `main` y aplicado a prod, *no se edita ni se borra nunca más*. Si te equivocaste, escribís **otra** migración que enmiende. Local es lo opuesto: podés borrar / renombrar / resetear todo lo que quieras *antes* de mergear.

Por qué: en prod tenés data real, `supabase db push` sólo aplica archivos nuevos, y cualquier cambio retroactivo desincroniza al resto del equipo (que ya aplicó la versión anterior en su DB local y en sus PR previews).

### Flujo dev → PR → prod

El SQL en `supabase/migrations/` es la fuente de verdad. Los archivos `prisma/schema/*.prisma` se mantienen a mano para que matcheen el SQL — Prisma sólo genera el cliente TypeScript, no maneja migraciones.

**1. Local (todo el laburo iterativo va acá).** Workflow para agregar/modificar el schema:

```bash
# 1. Crear el archivo de migración vacío
make migration NAME=add_vehicles

# 2. Editar el SQL en supabase/migrations/<timestamp>_add_vehicles.sql
#    Si la tabla tiene tenant_id, replicar el patrón RLS de `users` (RLS + REVOKE anon + policies con (select auth.jwt())).

# 3. Reflejar el cambio en prisma/schema/*.prisma (agregar/modificar el model correspondiente).

# 4. Aplicar la migración local + regenerar el cliente Prisma
make migration-apply

# 5. Si la tabla tiene tenant_id: agregar el modelo a TENANT_MODELS
#    en src/database/prisma-tenant.ts.
```

Mientras estés en tu rama podés tirar el archivo, renombrarlo, modificarlo, resetear (`make reset`) cien veces. Local es desechable.

**Cuándo usar `make reset`**: si rompiste el SQL y `make migration-apply` deja la DB en un estado inconsistente, o cuando querés validar que la migración corre limpia desde cero. Borra data local y re-aplica todo.

**Pulleaste cambios de un compañero**: corré `make migration-apply` — aplica las migraciones que él/ella agregó y regenera tu cliente Prisma. Mismo comando que cuando aplicás las tuyas.

**Al desplegar a prod** (manual o CI), corré `make push` para aplicar migraciones usando `DIRECT_URL` del `.env` (o de variables inyectadas en CI). Aplica sólo las migraciones nuevas. La data persiste.

A partir de ese momento ese archivo está **congelado**. Cambios futuros van en una migración nueva.

### Reglas para no romper prod

- **Forward-only**: no hay rollback. Si te equivocaste, escribís una migración nueva que enmiende.
- **Una migración = un cambio coherente**. No mezcles "agregar tabla X" con "renombrar columna Y" en el mismo archivo.
- **Nunca editar un archivo ya mergeado a `main`**. Si necesitás corregir, una migración nueva.
- **Cambios destructivos en pasos** (expand/contract):
    1. Migración: agregar la columna nueva.
    2. Deploy: el código empieza a leer/escribir las dos.
    3. Backfill: copiar datos de la vieja a la nueva.
    4. Deploy: el código deja de usar la vieja.
    5. Migración: `DROP COLUMN` la vieja (días después, cuando estés seguro).
- **Renombrar es destructivo**: aplicá expand/contract en vez de `RENAME`.
- **Backfills grandes en batches**, no en una sola transacción.
- **Tablas grandes con tráfico**: usar `CREATE INDEX CONCURRENTLY`, evitar `ALTER TABLE` que tome `ACCESS EXCLUSIVE` lock por mucho tiempo.
- **Probar en una Supabase branch** antes del merge cuando el cambio sea sensible.

## Reglas de convivencia

- `develop` (STAGING) es compartida: avisar antes de cambios grandes o force-push.
- No mezclar tareas distintas en un mismo PR.
- Un PR contiene **solo** los commits de su rama, no cambios traídos de otras.
- Ante dudas o conflictos no triviales, consultar al equipo antes de resetear.
