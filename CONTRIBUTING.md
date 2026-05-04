# Contributing

Este documento describe el flujo de trabajo Git, la convención de commits y la política de Pull Requests del proyecto **Parkit**. Es de lectura obligatoria antes de abrir tu primer PR.

## Modelo de ramas y entornos

Trabajamos con dos ramas permanentes y branches por feature/fix. **No hay SANDBOX**: la validación previa a producción ocurre en `develop` (STAGING).

### Ramas permanentes

| Rama      | Entorno  | Propósito                                                                 |
| --------- | -------- | ------------------------------------------------------------------------- |
| `main`    | PROD     | Producción. Solo llegan cambios aprobados vía PR.                         |
| `develop` | STAGING  | Entorno compartido para QA/demos. Se valida acá antes de mergear a `main`. |

> `develop` (STAGING) es **compartido**: avisar antes de cambios grandes, mantenerlo ordenado y coordinar reescrituras de historia.

### Ramas temporales

| Prefijo   | Para qué sirve                            | Origen | PR apunta a |
| --------- | ----------------------------------------- | ------ | ----------- |
| `feat/*`  | Nuevas funcionalidades                    | `main` | `main`      |
| `fix/*`   | Correcciones de bugs                      | `main` | `main`      |
| `docs/*`  | Cambios solo de documentación             | `main` | `main`      |
| `chore/*` | Tooling, dependencias, mantenimiento, CI  | `main` | `main`      |

Las ramas temporales **siempre salen de `main` actualizado** y **siempre apuntan a `main`** en el PR. `develop` es solo entorno de validación: se llega a STAGING reposicionando la rama de feature sobre `develop` (ver flujo más abajo), no abriendo un PR contra `develop`.

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

1. **Todos los PR apuntan a `main`**. La validación previa pasa por `develop` (STAGING), no por un PR.
2. **Mínimo 1 reviewer** debe aprobar antes del merge.
3. **CI obligatorio en verde:** lint y tests deben pasar. No se mergea con checks rojos.
4. **Conventional commits** en el título del PR.
5. **Referencia a JIRA** en el cuerpo del PR (`Refs SCRUM-XXX`).
6. **Squash & merge** como estrategia por defecto.
7. **Borrar la rama** una vez mergeado el PR.
8. **Un PR = una rama = una tarea**: no mezclar cambios de otras ramas o tareas.

## Protección de ramas

- `main`: protegida. No se puede pushear directo. Requiere PR aprobado y CI verde.
- `develop`: compartida. Permite force-push para reposicionar features sobre `main`, pero **siempre con `--force-with-lease`** y coordinando.

## Flujo típico de una feature

El flujo usa **rebase** para mantener la rama siempre arriba del último `main`. Esto evita probar contra una base vieja y minimiza conflictos al abrir el PR.

### 1. Partir de `main` actualizado

```bash
git switch main
git pull --rebase origin main
git switch -c feat/SCRUM-42-login-con-google
```

### 2. Desarrollar y commitear

Trabajar normalmente, aplicando Conventional Commits.

```bash
git add .
git commit -m "feat(auth): agregar handler de OAuth Google"
```

Pushear la rama (la primera vez con `-u`):

```bash
git pull --rebase origin main
git push -u origin feat/SCRUM-42-login-con-google
```

Si reescribiste historia tras un rebase, usar:

```bash
git push --force-with-lease
```

> Nunca usar `--force` a secas: `--force-with-lease` aborta el push si alguien más subió commits a tu rama desde tu último fetch, evitando pisar trabajo ajeno.

### 3. Validar en STAGING (`develop`)

Antes de pedir review se valida la rama en `develop`. Estamos *reposicionando* la rama de feature encima de `develop` y pusheándola — `develop` no acumula merges de features:

```bash
git fetch origin
git switch feat/SCRUM-42-login-con-google
git pull --rebase origin main          # rebasear sobre la última main
git switch -C develop origin/develop   # mover la rama local develop al remoto
git pull --rebase origin main          # llevar develop también al tope de main
git merge --ff-only feat/SCRUM-42-login-con-google
git push --force-with-lease origin develop
```

Ese push dispara el pipeline de STAGING. Si para QA hace falta historia más prolija, squashear primero los commits del feature:

```bash
git switch feat/SCRUM-42-login-con-google
git rebase -i origin/main
# en el editor: dejar `pick` el primero, `squash` (s) los demás
```

> **Nota sobre coordinación:** `develop` es compartida. Si otra persona tiene su feature ahí probándose, avisar en el canal del equipo antes de force-pushear. La regla es: el último que sube re-rebasa sobre `main` para evitar dejar el entorno desactualizado.

### 4. Abrir PR contra `main`

Cuando el cambio está validado en STAGING, abrir el PR de la rama de feature a `main`, asignar al menos 1 reviewer, esperar CI verde y mergear con squash & merge. Borrar la rama tras el merge.

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

Si STAGING quedó inconsistente y se acuerda con el equipo reiniciarla:

```bash
git fetch origin
git switch develop
git reset --hard origin/main
git push --force-with-lease
```

Esto borra commits que otras personas pudieran estar probando — **avisar siempre antes** en el canal del equipo.

## Reglas de convivencia

- `develop` (STAGING) es compartida: avisar antes de cambios grandes o force-push.
- No mezclar tareas distintas en un mismo PR.
- Un PR contiene **solo** los commits de su rama, no cambios traídos de otras.
- Ante dudas o conflictos no triviales, consultar al equipo antes de resetear.
