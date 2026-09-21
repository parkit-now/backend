/**
 * Genera el SQL de la PLANTILLA del catálogo de vehículos. Imprime a stdout.
 *
 *   make catalog-sql                     # sólo el INSERT de la plantilla
 *   make catalog-migration               # la migración completa, ya en su archivo
 *   bun run scripts/gen-vehicle-catalog.ts --with-backfill > migracion.sql
 *
 * Es PURO: no toca la red ni la base. Lee `data/vehicle-catalog.json` (lo
 * escribe `make catalog-import`, el único script que scrapea) y los dos archivos
 * curados, y emite SQL. Regenerar la migración no re-scrapea nada.
 *
 * No corre en ningún hook ni pipeline: es una herramienta de desarrollo, y su
 * output queda versionado en el SQL.
 *
 * DE DÓNDE SALE CADA MODELO
 *
 *   data/vehicle-catalog.json   ~1.150 modelos importados, con su carrocería
 *   data/vehicle-brands.ts         245 modelos curados a mano
 *   data/vehicle-types.ts       overrides de tipo + mapeo de carrocerías
 *
 * El catálogo final es la UNIÓN de los dos primeros. Lo curado gana: en el
 * nombre (el sitio parte `Citroën Berlingo` en `Berlingo Furgón` y `Berlingo
 * Multispace`) y en el tipo. Y hay 34 modelos que se venden mucho acá y la
 * fuente no tiene —T-Cross, toda Great Wall, toda Lifan, BYD Atto 3—, así que
 * reemplazar en vez de unir perdería justo lo que alguien ya había curado.
 *
 * QUÉ ES LA PLANTILLA
 *
 * `vehicle_catalog_defaults` no la ve ningún estacionamiento: la lee sólo
 * `bootstrap_tenant_defaults()`, el trigger `AFTER INSERT ON tenants`, que le
 * da a cada cuenta NUEVA su copia propia y editable de estos modelos. Cambiar
 * la plantilla afecta a las cuentas que se creen de ahora en más; nunca toca a
 * las playas existentes, que son dueñas de su catálogo. Para alcanzarlas hace
 * falta el bloque de backfill (`--with-backfill`).
 *
 * POR QUÉ UNA MIGRACIÓN Y NO `supabase/seed.sql`
 *
 * `seed.sql` es local-only por diseño: `supabase db push --linked` NUNCA lo
 * aplica. Si la plantilla viviera ahí, producción arrancaría vacía y cada
 * cuenta nueva nacería sin catálogo. Es dato de referencia de la plataforma, no
 * fixtures de desarrollo.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BRANDS } from './data/vehicle-brands';
import {
  CARROCERIA_TO_TYPE,
  DEFAULT_TYPE_NAMES,
  EXCLUDED_CARROCERIAS,
  EXCLUDED_MODELS,
  MODEL_TYPES,
  TEMPLATE_TYPE_NAME,
  type CatalogVehicleType,
} from './data/vehicle-types';

const CATALOG_JSON = join(__dirname, 'data', 'vehicle-catalog.json');

/** Límites de `vehicle_catalog_defaults`. Mejor fallar acá que en el INSERT. */
const MAX_BRAND_LEN = 120;
const MAX_MODEL_LEN = 120;
const MAX_TYPE_NAME_LEN = 60;

interface ImportedEntry {
  brand: string;
  model: string;
  carroceria: string;
  source: string;
}

/** Misma normalización que `vehicles_scope_brand_model_uidx`: lower + btrim. */
function key(brand: string, model: string): string {
  return `${brand.trim().toLowerCase()}|${model.trim().toLowerCase()}`;
}

/**
 * Slug `marca/modelo` de la ficha de origen, la identidad estable de la fila.
 * Sirve tanto para las URLs argentinas como para las `/uy/`.
 */
function sourceSlug(source: string): string {
  return source.split('/fichas-tecnicas/')[1]?.split('/').slice(0, 2).join('/') ?? '';
}

/** Postgres: escapar comilla simple duplicándola. */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function loadImported(): ImportedEntry[] {
  let raw: string;
  try {
    raw = readFileSync(CATALOG_JSON, 'utf8');
  } catch {
    throw new Error(
      `Falta ${CATALOG_JSON}.\n` +
        'Es el catálogo importado. Generalo con:  make catalog-import',
    );
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${CATALOG_JSON} debería ser un array de modelos.`);
  }
  return parsed as ImportedEntry[];
}

/**
 * Índice de overrides por clave normalizada.
 *
 * Se normaliza en vez de leer `MODEL_TYPES[brand][model]` directo porque las dos
 * puntas escriben los nombres por su cuenta: el override dice `BMW` y la fuente
 * podría decir `Bmw`, y un override que no matchea es un override que no se
 * aplica, en silencio.
 */
function indexOverrides(): Map<string, CatalogVehicleType> {
  const index = new Map<string, CatalogVehicleType>();
  for (const [brand, byModel] of Object.entries(MODEL_TYPES)) {
    for (const [model, type] of Object.entries(byModel)) {
      index.set(key(brand, model), type);
    }
  }
  return index;
}

interface CatalogRow {
  brand: string;
  model: string;
  /** Carrocería: el dato de origen. */
  type: CatalogVehicleType;
  /** Nombre del tipo por defecto con el que se siembra. */
  typeName: string;
}

interface BuildResult {
  rows: CatalogRow[];
  curated: number;
  imported: number;
  /** Descartados por carrocería y por slug, separados para poder explicarlos. */
  excludedByCarroceria: number;
  excludedByModel: number;
}

function buildCatalog(): BuildResult {
  const overrides = indexOverrides();
  const imported = loadImported();

  /**
   * Clave normalizada -> fila en construcción. El primero que la reclama se
   * queda con el NOMBRE; `type: null` es "todavía sin clasificar" y lo puede
   * completar la fuente en (2).
   */
  interface WorkingRow {
    brand: string;
    model: string;
    type: CatalogVehicleType | null;
    /** Para distinguir un choque esperado (curado gana) de un colapso real. */
    curated: boolean;
  }
  const claimed = new Map<string, WorkingRow>();
  const unclassified: string[] = [];
  const unknownCarrocerias = new Map<string, string[]>();
  const duplicates: string[] = [];
  const collapsed: string[] = [];
  let curatedCount = 0;
  let importedCount = 0;
  let excludedByCarroceria = 0;
  let excludedByModel = 0;

  // ─── (1) lo curado primero: gana en nombre y en tipo ──────────────────────
  for (const brand of BRANDS) {
    for (const model of brand.models) {
      const k = key(brand.name, model);

      // `vehicleBrands.ts` trae `Peugeot / 308` dos veces. Sin este dedupe el
      // INSERT viola el índice único apenas se crea.
      if (claimed.has(k)) {
        duplicates.push(`${brand.name} ${model}`);
        continue;
      }

      // Sin override queda pendiente: si la fuente lo trae, (2) lo completa; si
      // no, el guard de abajo lo nombra.
      const type = overrides.get(k) ?? null;
      claimed.set(k, { brand: brand.name, model, type, curated: true });
      if (type) curatedCount++;
    }
  }

  // Una carrocería no puede estar excluida Y mapeada: es una contradicción que
  // deja sin saber cuál de las dos intenciones vale.
  const contradictory = EXCLUDED_CARROCERIAS.filter((c) => c in CARROCERIA_TO_TYPE);
  if (contradictory.length > 0) {
    throw new Error(
      'Carrocería(s) a la vez en EXCLUDED_CARROCERIAS y CARROCERIA_TO_TYPE: ' +
        contradictory.join(', '),
    );
  }

  // ─── (2) el bulk importado ────────────────────────────────────────────────
  const unusedExclusions = new Set(EXCLUDED_MODELS);

  for (const entry of imported) {
    if (EXCLUDED_CARROCERIAS.includes(entry.carroceria)) {
      excludedByCarroceria++;
      continue;
    }

    const slug = sourceSlug(entry.source);
    if (EXCLUDED_MODELS.includes(slug)) {
      unusedExclusions.delete(slug);
      excludedByModel++;
      continue;
    }

    const k = key(entry.brand, entry.model);
    const fromSource = CARROCERIA_TO_TYPE[entry.carroceria];

    if (!fromSource) {
      const list = unknownCarrocerias.get(entry.carroceria) ?? [];
      list.push(`${entry.brand} ${entry.model}`);
      unknownCarrocerias.set(entry.carroceria, list);
      continue;
    }

    const existing = claimed.get(k);
    if (existing) {
      if (existing.curated) {
        // Choque esperado: lo curado gana. Conserva SU nombre; el tipo sólo se
        // completa si venía pendiente (sin override).
        if (existing.type === null) {
          existing.type = fromSource;
          importedCount++;
        }
      } else {
        // Colapso real: dos fichas DISTINTAS de la fuente que caen en la misma
        // clave normalizada (la PK de vehicle_catalog_defaults es (brand,
        // model)). Pasa cuando el sitio separa generaciones o carrocerías por
        // slug pero les pone el mismo nombre: `chevrolet/sonic` (Sedán) y
        // `chevrolet/sonic-suv` (SUV) son los dos "Chevrolet Sonic".
        //
        // Para un autocompletado un nombre = una fila, así que descartar está
        // bien; se reporta con la URL descartada para poder desambiguar a mano
        // en vehicle-brands.ts si alguna vez importa.
        collapsed.push(`${entry.brand} ${entry.model} — descartada ${entry.source}`);
      }
      continue;
    }

    claimed.set(k, {
      brand: entry.brand,
      model: entry.model,
      type: overrides.get(k) ?? fromSource,
      curated: false,
    });
    importedCount++;
  }

  // ─── guards ───────────────────────────────────────────────────────────────

  // Sin default a propósito: un modelo nuevo mal tipificado en silencio es peor
  // que un generador que no corre, porque los globales son read-only y nadie
  // podría corregirlo desde la app.
  for (const row of claimed.values()) {
    if (row.type === null) unclassified.push(`${row.brand} ${row.model}`);
  }
  if (unclassified.length > 0) {
    throw new Error(
      `Faltan tipos para ${unclassified.length} modelo(s) curado(s). La fuente no los\n` +
        'trae, así que hay que clasificarlos a mano en MODEL_TYPES\n' +
        '(scripts/data/vehicle-types.ts):\n' +
        unclassified.map((m) => `  - ${m}`).join('\n'),
    );
  }

  // Misma lógica un nivel más arriba: una carrocería que no sabemos traducir no
  // se adivina, se agrega a CARROCERIA_TO_TYPE.
  if (unknownCarrocerias.size > 0) {
    const detail = [...unknownCarrocerias]
      .map(([carroceria, models]) => {
        const sample = models.slice(0, 5).join(', ');
        const rest = models.length > 5 ? `, … (+${models.length - 5})` : '';
        return `  - "${carroceria}" (${models.length}): ${sample}${rest}`;
      })
      .join('\n');
    throw new Error(
      `${unknownCarrocerias.size} carrocería(s) sin mapear en CARROCERIA_TO_TYPE\n` +
        `(scripts/data/vehicle-types.ts):\n${detail}`,
    );
  }

  // Al revés también: una entrada del mapa que ya no existe en el catálogo es
  // una clasificación muerta, y suele ser un typo en el nombre del modelo.
  const orphans: string[] = [];
  for (const [brandName, byModel] of Object.entries(MODEL_TYPES)) {
    for (const model of Object.keys(byModel)) {
      if (!claimed.has(key(brandName, model))) orphans.push(`${brandName} ${model}`);
    }
  }
  if (orphans.length > 0) {
    throw new Error(
      `MODEL_TYPES clasifica ${orphans.length} modelo(s) que no están en el catálogo\n` +
        '(vehicle-brands.ts ∪ vehicle-catalog.json):\n' +
        orphans.map((m) => `  - ${m}`).join('\n'),
    );
  }

  // Mismo razonamiento para las exclusiones: un slug que no matchea ninguna
  // ficha es una exclusión que no se aplica, y el modelo que creíamos afuera
  // termina adentro. Suele ser un typo, o que la fuente renombró el slug.
  if (unusedExclusions.size > 0) {
    throw new Error(
      `EXCLUDED_MODELS excluye ${unusedExclusions.size} slug(s) que no están en\n` +
        'vehicle-catalog.json (¿typo, o la fuente los renombró?):\n' +
        [...unusedExclusions].map((s) => `  - ${s}`).join('\n'),
    );
  }

  // La plantilla no puede apuntar a un tipo que no exista entre los defaults. La
  // FK a `vehicle_type_defaults(name)` es el backstop en la base; esto falla
  // acá, antes de emitir una sola línea de SQL.
  const unknownTypeNames = [...new Set(Object.values(TEMPLATE_TYPE_NAME))].filter(
    (name) => !DEFAULT_TYPE_NAMES.includes(name as (typeof DEFAULT_TYPE_NAMES)[number]),
  );
  if (unknownTypeNames.length > 0) {
    throw new Error(
      `TEMPLATE_TYPE_NAME apunta a tipos que no están en DEFAULT_TYPE_NAMES: ${unknownTypeNames.join(', ')}`,
    );
  }

  // Pasado el guard de arriba, ningún `type` quedó en null.
  const rows: CatalogRow[] = [...claimed.values()]
    .map(({ brand, model, type }) => ({
      brand,
      model,
      type: type as CatalogVehicleType,
      typeName: TEMPLATE_TYPE_NAME[type as CatalogVehicleType],
    }))
    .sort((a, b) => a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model));

  // Los límites de columna. Un varchar que se pasa aborta el INSERT entero a
  // mitad de la migración; acá se ve cuál es y se arregla antes.
  const tooLong: string[] = [];
  for (const row of rows) {
    if (row.brand.length > MAX_BRAND_LEN) tooLong.push(`brand: ${row.brand}`);
    if (row.model.length > MAX_MODEL_LEN) tooLong.push(`model: ${row.model}`);
    if (row.typeName.length > MAX_TYPE_NAME_LEN) {
      tooLong.push(`type_name: ${row.typeName}`);
    }
  }
  if (tooLong.length > 0) {
    throw new Error(
      `${tooLong.length} valor(es) exceden el largo de su columna:\n` +
        tooLong.map((m) => `  - ${m}`).join('\n'),
    );
  }

  if (duplicates.length > 0) {
    console.error(`-- Duplicados descartados: ${duplicates.join(', ')}`);
  }
  if (collapsed.length > 0) {
    console.error(
      `-- ${collapsed.length} modelo(s) importado(s) colapsaron contra otro ya tomado:`,
    );
    for (const item of collapsed) console.error(`--   ${item}`);
  }

  return {
    rows,
    curated: curatedCount,
    imported: importedCount,
    excludedByCarroceria,
    excludedByModel,
  };
}

/**
 * Backfill de las playas que YA existen.
 *
 * La plantilla sola sólo alcanza a las cuentas nuevas (vía el trigger). Este
 * bloque le lleva los modelos nuevos a las que ya estaban.
 */
function backfillSql(): string {
  return `

-- ─── Backfill de los tenants existentes ─────────────────────────────────────
--
-- El INSERT de arriba sólo alcanza a las cuentas NUEVAS, porque la plantilla la
-- lee el trigger \`bootstrap_tenant_defaults()\` en el AFTER INSERT de tenants.
-- Esto le lleva los modelos nuevos a las playas que ya existen.
--
-- Mismo patrón que 20260901013345 y 20260901011955, más un NOT EXISTS.
--
-- POR QUÉ EL NOT EXISTS Y POR QUÉ NO ALCANZA EL ON CONFLICT
--
-- \`vehicles_tenant_brand_model_uidx\` es un índice PARCIAL (WHERE deleted_at IS
-- NULL). Una fila que el dueño borró lógicamente no está en el índice, así que
-- el ON CONFLICT no la ve y el INSERT entraría: el backfill le resucitaría los
-- modelos que sacó a propósito, y encima con id nuevo. El NOT EXISTS mira todas
-- las filas del tenant, borradas incluidas.
--
-- El ON CONFLICT se conserva igual, para el caso de dos filas de la plantilla
-- que colapsen bajo lower(btrim(...)) — la PK de vehicle_catalog_defaults es
-- case-sensitive y el índice de vehicles no.
--
-- POR QUÉ INSERT Y NO UPDATE
--
-- \`set_vehicles_sync_fields\` es un BEFORE UPDATE que bumpea sync_seq Y version.
-- Un UPDATE masivo le invalidaría a todos los clientes offline las \`version\`
-- cacheadas y les haría re-pullear el catálogo entero. Un INSERT no lo dispara:
-- las filas nuevas toman sync_seq del DEFAULT nextval(...) y viajan por
-- pullChanges como cualquier alta.
--
-- No se pasa \`sync_seq\` a mano: ese fue el bug que reparó
-- 20260604024720_fix_sync_seq_zero.sql.

INSERT INTO vehicles (id, tenant_id, brand, model, type_id)
SELECT gen_random_uuid(), t.id, d.brand, d.model, vt.id
  FROM tenants t
  CROSS JOIN vehicle_catalog_defaults d
  JOIN vehicle_types vt
    ON vt.tenant_id = t.id
   AND vt.deleted_at IS NULL
   AND lower(btrim(vt.name)) = lower(btrim(d.type_name))
 WHERE NOT EXISTS (
   SELECT 1
     FROM vehicles v
    WHERE v.tenant_id = t.id
      AND lower(btrim(v.brand)) = lower(btrim(d.brand))
      AND lower(btrim(v.model)) = lower(btrim(d.model))
 )
ON CONFLICT DO NOTHING;
`;
}

function main(): void {
  const withBackfill = process.argv.includes('--with-backfill');
  const { rows, curated, imported, excludedByCarroceria, excludedByModel } =
    buildCatalog();

  const byTypeName = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.typeName] = (acc[r.typeName] ?? 0) + 1;
    return acc;
  }, {});
  const brands = new Set(rows.map((r) => r.brand)).size;

  const values = rows
    .map((r) => `  (${lit(r.brand)}, ${lit(r.model)}, ${lit(r.typeName)})`)
    .join(',\n');

  process.stdout.write(`-- Plantilla del catálogo de vehículos: ${brands} marcas, ${rows.length} modelos.
-- Reparto por tipo sembrado: ${Object.entries(byTypeName)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}=${n}`)
    .join(', ')}.
-- Origen: ${curated} clasificados a mano, ${imported} importados con su carrocería.${
    excludedByCarroceria > 0 || excludedByModel > 0
      ? `\n-- Excluidos a propósito (scripts/data/vehicle-types.ts): ${[
          excludedByCarroceria > 0
            ? `${excludedByCarroceria} por carrocería (EXCLUDED_CARROCERIAS)`
            : null,
          excludedByModel > 0 ? `${excludedByModel} por slug (EXCLUDED_MODELS)` : null,
        ]
          .filter(Boolean)
          .join(', ')}.`
      : ''
  }
--
-- GENERADO por scripts/gen-vehicle-catalog.ts — NO editar a mano. Para cambiar
-- la plantilla: editar scripts/data/vehicle-brands.ts y scripts/data/vehicle-types.ts
-- (o re-importar con \`make catalog-import\`), y regenerar con
-- \`make catalog-migration\`. Las migraciones ya mergeadas son append-only: si
-- ésta ya está en main, va una nueva.
--
-- Esta tabla NO la ve ningún estacionamiento. La lee sólo
-- \`bootstrap_tenant_defaults()\`, que le da a cada cuenta nueva su copia propia
-- y editable.${withBackfill ? ' A las playas que ya existen las alcanza el\n-- bloque de backfill del final.' : ' Cambiarla afecta a las cuentas futuras; nunca a las\n-- existentes.'}
--
-- Los utilitarios (Kangoo, Partner, Berlingo, furgones y chasis) se siembran
-- como "Otro": "Utilitario" no está entre los siete defaults a propósito, es el
-- ejemplo canónico de la categoría que crea el dueño. El mapeo vive en
-- TEMPLATE_TYPE_NAME (scripts/data/vehicle-types.ts), en una sola línea.
--
-- Sin \`id\`: la PK es (brand, model) y cada tenant genera los suyos al copiar.
-- Eso elimina el aparato de UUIDv5 determinísticos que necesitaba el catálogo
-- global, donde los ids eran compartidos por todas las playas.

INSERT INTO vehicle_catalog_defaults (brand, model, type_name) VALUES
${values}
ON CONFLICT DO NOTHING;
${withBackfill ? backfillSql() : ''}`);
}

main();
