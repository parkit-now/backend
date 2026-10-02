#!/usr/bin/env bash
#
# Guardián de migraciones: falla si el orden de `supabase/migrations` no puede
# aplicarse sobre la rama base.
#
# POR QUÉ EXISTE
#
# `supabase db push` aplica los archivos en orden de nombre y lleva la cuenta en
# `supabase_migrations.schema_migrations`. Si una rama agrega una migración con
# timestamp ANTERIOR a la última ya aplicada en la base, la CLI se planta:
#
#   Found local migration files to be inserted before the last migration on
#   remote database. Rerun the command with --include-all flag to apply these.
#
# El `--include-all` la aplica igual, pero fuera de orden: la migración vieja
# corre DESPUÉS de las nuevas. Si toca algo que las nuevas ya modificaron, el
# resultado depende de en qué base se corrió y deja de ser reproducible.
#
# Esto ya pasó en este repo: `20260829202737_add_metrics_indexes.sql` se mergeó
# a develop con fecha vieja, bloqueó el push a producción, y producción quedó
# 5 migraciones atrás sin que nadie se enterara hasta que el backend desplegado
# empezó a devolver 404 (Prisma pedía columnas que la base no tenía).
#
# QUÉ VERIFICA
#
#   1. Nombre con formato `<14 dígitos>_<snake_case>.sql`.
#   2. Sin timestamps duplicados (dos migraciones con el mismo prefijo tienen
#      orden indefinido entre sí).
#   3. Ninguna migración nueva de esta rama es anterior a la última que ya está
#      en la rama base.
#
# USO
#
#   scripts/check-migrations.sh [rama-base]
#
# Sin argumento usa `origin/$GITHUB_BASE_REF` (pull request) o `origin/develop`.

set -euo pipefail

MIGRATIONS_DIR="supabase/migrations"
NAME_PATTERN='^[0-9]{14}_[a-z0-9_]+\.sql$'

cd "$(git rev-parse --show-toplevel)"

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "✗ No existe $MIGRATIONS_DIR" >&2
  exit 1
fi

fail() {
  echo "" >&2
  echo "✗ $1" >&2
  exit 1
}

# ── 1. Formato de nombre ─────────────────────────────────────────────────────
invalid=()
while IFS= read -r path; do
  name="$(basename "$path")"
  [[ "$name" =~ $NAME_PATTERN ]] || invalid+=("$name")
done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' | sort)

if [[ ${#invalid[@]} -gt 0 ]]; then
  printf '  %s\n' "${invalid[@]}" >&2
  fail "Nombre de migración inválido. Formato: <14 dígitos>_<snake_case>.sql
  Generalas con 'make migration NAME=add_<feature>' para no equivocarte."
fi

# ── 2. Timestamps duplicados ─────────────────────────────────────────────────
duplicates="$(
  find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' -exec basename {} \; \
    | cut -c1-14 | sort | uniq -d
)"

if [[ -n "$duplicates" ]]; then
  echo "$duplicates" | while read -r ts; do
    echo "  timestamp $ts:" >&2
    find "$MIGRATIONS_DIR" -maxdepth 1 -name "${ts}_*.sql" \
      -exec basename {} \; | sed 's/^/    /' >&2
  done
  fail "Dos migraciones comparten timestamp: el orden entre ellas es indefinido.
  Renombrá una con un timestamp posterior."
fi

# ── 3. Orden contra la rama base ─────────────────────────────────────────────
base_ref="${1:-}"
if [[ -z "$base_ref" ]]; then
  if [[ -n "${GITHUB_BASE_REF:-}" ]]; then
    base_ref="origin/${GITHUB_BASE_REF}"
  else
    base_ref="origin/develop"
  fi
fi

if ! git rev-parse --verify --quiet "$base_ref^{commit}" >/dev/null; then
  echo "⚠ No se pudo resolver la rama base '$base_ref'; se omite el chequeo de orden."
  echo "  (en CI hace falta actions/checkout con fetch-depth: 0)"
  echo "✓ Migraciones OK (formato y duplicados)"
  exit 0
fi

# La última migración que la rama base ya conoce. Cualquier cosa que agreguemos
# tiene que ir después de esta.
base_latest="$(
  git ls-tree --name-only "$base_ref" -- "$MIGRATIONS_DIR/" \
    | xargs -r -n1 basename \
    | grep -E '\.sql$' \
    | sort \
    | tail -1 \
    || true
)"

if [[ -z "$base_latest" ]]; then
  echo "✓ Migraciones OK (la rama base no tiene migraciones)"
  exit 0
fi

base_latest_ts="${base_latest:0:14}"

# Lo que hay AHORA en el directorio menos lo que la rama base ya conocía.
#
# Se mira el disco y no `git diff base...HEAD` a propósito: en el pre-commit el
# archivo nuevo está en el índice pero todavía NO en HEAD, así que un diff entre
# commits no lo ve y el hook dejaba pasar justo el commit que introduce el
# problema. Mirar el working tree cubre los tres casos —sin agregar, staged y
# commiteado— que es lo que el hook necesita.
base_files="$(
  git ls-tree --name-only "$base_ref" -- "$MIGRATIONS_DIR/" \
    | xargs -r -n1 basename \
    | grep -E '\.sql$' || true
)"

added=()
while IFS= read -r path; do
  name="$(basename "$path")"
  grep -qxF "$name" <<<"$base_files" || added+=("$name")
done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' | sort)

if [[ ${#added[@]} -eq 0 ]]; then
  echo "✓ Migraciones OK (esta rama no agrega ninguna)"
  exit 0
fi

out_of_order=()
for name in "${added[@]}"; do
  [[ "${name:0:14}" > "$base_latest_ts" ]] || out_of_order+=("$name")
done

if [[ ${#out_of_order[@]} -gt 0 ]]; then
  printf '  %s\n' "${out_of_order[@]}" >&2
  fail "Migración fuera de orden respecto de '$base_ref'.
  La última migración en la base es:
    $base_latest
  Las de arriba tienen un timestamp anterior o igual, así que 'supabase db push'
  las va a rechazar y va a bloquear el deploy a producción.

  Arreglo: renombrá el archivo con un timestamp posterior, por ejemplo
    git mv $MIGRATIONS_DIR/${out_of_order[0]} \\
           $MIGRATIONS_DIR/$(date -u +%Y%m%d%H%M%S)_${out_of_order[0]:15}
  Renombrar es seguro mientras la migración NO se haya aplicado a ningún
  entorno compartido. Si ya se aplicó en develop, coordinalo con el equipo."
fi

echo "✓ Migraciones OK (${#added[@]} nueva/s, todas posteriores a $base_latest)"
