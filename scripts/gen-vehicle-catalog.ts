/**
 * Genera el SQL de la PLANTILLA del catálogo de vehículos. Imprime a stdout.
 *
 *   bun run scripts/gen-vehicle-catalog.ts > /tmp/catalog.sql
 *
 * La salida se pega dentro de una migración NUEVA (las migraciones son
 * append-only). No se corre solo en ningún hook ni pipeline: es una herramienta
 * de desarrollo, y su output queda versionado en el SQL.
 *
 * QUÉ ES LA PLANTILLA
 *
 * `vehicle_catalog_defaults` no la ve ningún estacionamiento: la lee sólo
 * `bootstrap_tenant_defaults()`, el trigger `AFTER INSERT ON tenants`, que le
 * da a cada cuenta NUEVA su copia propia y editable de estos modelos. Cambiar
 * la plantilla afecta a las cuentas que se creen de ahora en más; nunca toca a
 * las playas existentes, que son dueñas de su catálogo.
 *
 * POR QUÉ UNA MIGRACIÓN Y NO `supabase/seed.sql`
 *
 * `seed.sql` es local-only por diseño: `supabase db push --linked` NUNCA lo
 * aplica. Si la plantilla viviera ahí, producción arrancaría vacía y cada
 * cuenta nueva nacería sin catálogo. Es dato de referencia de la plataforma, no
 * fixtures de desarrollo.
 */
import { BRANDS } from './data/vehicle-brands';
import {
  DEFAULT_TYPE_NAMES,
  MODEL_TYPES,
  TEMPLATE_TYPE_NAME,
  type CatalogVehicleType,
} from './data/vehicle-types';

/** Misma normalización que `vehicles_scope_brand_model_uidx`: lower + btrim. */
function key(brand: string, model: string): string {
  return `${brand.trim().toLowerCase()}|${model.trim().toLowerCase()}`;
}

/** Postgres: escapar comilla simple duplicándola. */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface CatalogRow {
  brand: string;
  model: string;
  /** Carrocería: el dato de origen. */
  type: CatalogVehicleType;
  /** Nombre del tipo por defecto con el que se siembra. */
  typeName: string;
}

function buildCatalog(): CatalogRow[] {
  const rows: CatalogRow[] = [];
  const seen = new Map<string, string>();
  const unclassified: string[] = [];
  const duplicates: string[] = [];

  for (const brand of BRANDS) {
    const byModel = MODEL_TYPES[brand.name];
    if (!byModel) {
      unclassified.push(`${brand.name} (marca entera sin clasificar)`);
      continue;
    }
    for (const model of brand.models) {
      const k = key(brand.name, model);

      // `vehicleBrands.ts` trae `Peugeot / 308` dos veces. Sin este dedupe el
      // INSERT viola el índice único apenas se crea.
      if (seen.has(k)) {
        duplicates.push(`${brand.name} ${model}`);
        continue;
      }
      seen.set(k, model);

      const type = byModel[model];
      if (!type) {
        unclassified.push(`${brand.name} ${model}`);
        continue;
      }
      rows.push({
        brand: brand.name,
        model,
        type,
        typeName: TEMPLATE_TYPE_NAME[type],
      });
    }
  }

  // Sin default a propósito: un modelo nuevo mal tipificado en silencio es peor
  // que un generador que no corre, porque los globales son read-only y nadie
  // podría corregirlo desde la app.
  if (unclassified.length > 0) {
    throw new Error(
      `Faltan tipos en scripts/data/vehicle-types.ts para ${unclassified.length} modelo(s):\n` +
        unclassified.map((m) => `  - ${m}`).join('\n'),
    );
  }

  // Al revés también: una entrada del mapa que ya no existe en el catálogo es
  // una clasificación muerta, y suele ser un typo en el nombre del modelo.
  const orphans: string[] = [];
  for (const [brandName, byModel] of Object.entries(MODEL_TYPES)) {
    const known = BRANDS.find((b) => b.name === brandName);
    if (!known) {
      orphans.push(`${brandName} (marca inexistente)`);
      continue;
    }
    for (const model of Object.keys(byModel)) {
      if (!known.models.includes(model)) orphans.push(`${brandName} ${model}`);
    }
  }
  if (orphans.length > 0) {
    throw new Error(
      `scripts/data/vehicle-types.ts clasifica ${orphans.length} modelo(s) que no están en vehicle-brands.ts:\n` +
        orphans.map((m) => `  - ${m}`).join('\n'),
    );
  }

  // Cuarto guard: la plantilla no puede apuntar a un tipo que no exista entre
  // los defaults. La FK a `vehicle_type_defaults(name)` es el backstop en la
  // base; esto falla acá, antes de emitir una sola línea de SQL.
  const unknownTypeNames = [...new Set(Object.values(TEMPLATE_TYPE_NAME))].filter(
    (name) => !DEFAULT_TYPE_NAMES.includes(name as (typeof DEFAULT_TYPE_NAMES)[number]),
  );
  if (unknownTypeNames.length > 0) {
    throw new Error(
      `TEMPLATE_TYPE_NAME apunta a tipos que no están en DEFAULT_TYPE_NAMES: ${unknownTypeNames.join(', ')}`,
    );
  }

  if (duplicates.length > 0) {
    console.error(`-- Duplicados descartados: ${duplicates.join(', ')}`);
  }

  return rows;
}

function main(): void {
  const rows = buildCatalog();
  const byTypeName = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.typeName] = (acc[r.typeName] ?? 0) + 1;
    return acc;
  }, {});

  const values = rows
    .map((r) => `  (${lit(r.brand)}, ${lit(r.model)}, ${lit(r.typeName)})`)
    .join(',\n');

  process.stdout.write(`-- Plantilla del catálogo de vehículos: ${BRANDS.length} marcas, ${rows.length} modelos.
-- Reparto por tipo sembrado: ${Object.entries(byTypeName)
    .map(([t, n]) => `${t}=${n}`)
    .join(', ')}.
--
-- GENERADO por scripts/gen-vehicle-catalog.ts — NO editar a mano. Para cambiar
-- la plantilla: editar scripts/data/vehicle-brands.ts y scripts/data/vehicle-types.ts,
-- re-correr el generador y agregar una migración NUEVA (append-only).
--
-- Esta tabla NO la ve ningún estacionamiento. La lee sólo
-- \`bootstrap_tenant_defaults()\`, que le da a cada cuenta nueva su copia propia
-- y editable. Cambiarla afecta a las cuentas futuras; nunca a las existentes.
--
-- Los 10 utilitarios (Kangoo, Partner, Berlingo...) se siembran como "Otro":
-- "Utilitario" no está entre los siete defaults a propósito, es el ejemplo
-- canónico de la categoría que crea el dueño. El mapeo vive en
-- TEMPLATE_TYPE_NAME (scripts/data/vehicle-types.ts), en una sola línea.
--
-- Sin \`id\`: la PK es (brand, model) y cada tenant genera los suyos al copiar.
-- Eso elimina el aparato de UUIDv5 determinísticos que necesitaba el catálogo
-- global, donde los ids eran compartidos por todas las playas.

INSERT INTO vehicle_catalog_defaults (brand, model, type_name) VALUES
${values}
ON CONFLICT DO NOTHING;
`);
}

main();
