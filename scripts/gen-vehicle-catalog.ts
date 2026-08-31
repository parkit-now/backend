/**
 * Genera el SQL del catálogo global de vehículos. Imprime a stdout.
 *
 *   bun run scripts/gen-vehicle-catalog.ts > /tmp/catalog.sql
 *
 * La salida se pega dentro de una migración NUEVA (las migraciones son
 * append-only). No se corre solo en ningún hook ni pipeline: es una herramienta
 * de desarrollo, y su output queda versionado en el SQL.
 *
 * POR QUÉ UNA MIGRACIÓN Y NO `supabase/seed.sql`
 *
 * `seed.sql` es local-only por diseño: `supabase db push --linked` NUNCA lo
 * aplica. Si el catálogo viviera ahí, producción arrancaría con cero vehículos
 * globales y el autocompletado del desktop quedaría vacío para todos los
 * tenants reales. El catálogo es dato de referencia de la plataforma, no
 * fixtures de desarrollo.
 */
import { createHash } from 'node:crypto';
import { BRANDS } from './data/vehicle-brands';
import { MODEL_TYPES, type CatalogVehicleType } from './data/vehicle-types';

/**
 * Namespace del UUIDv5. NUNCA CAMBIARLO: los ids se derivan de él, así que
 * cambiarlo re-genera los 244 y duplica el catálogo entero en cualquier base
 * que ya haya corrido la migración.
 */
const NAMESPACE = '3a3c1a1e-6f7d-4c9c-9a1e-8b6a2f0d5e11';

/**
 * Los 3 globales que sembraba `supabase/seed.sql` antes de esta migración. Sus
 * ids ya están publicados y sincronizados a los clientes offline; si el
 * generador les asignara un UUIDv5 nuevo, el INSERT chocaría contra la fila
 * existente en `vehicles_scope_brand_model_uidx`.
 */
const LEGACY_IDS: Record<string, string> = {
  'toyota|corolla': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  'ford|ranger': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
  'renault|kangoo': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
};

/** Misma normalización que `vehicles_scope_brand_model_uidx`: lower + btrim. */
function key(brand: string, model: string): string {
  return `${brand.trim().toLowerCase()}|${model.trim().toLowerCase()}`;
}

function uuidv5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const digest = createHash('sha1')
    .update(ns)
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // versión 5
  b[8] = (b[8] & 0x3f) | 0x80; // variante RFC 4122
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function vehicleId(brand: string, model: string): string {
  const k = key(brand, model);
  return LEGACY_IDS[k] ?? uuidv5(k, NAMESPACE);
}

/** Postgres: escapar comilla simple duplicándola. */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface CatalogRow {
  id: string;
  brand: string;
  model: string;
  type: CatalogVehicleType;
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
      rows.push({ id: vehicleId(brand.name, model), brand: brand.name, model, type });
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

  if (duplicates.length > 0) {
    console.error(`-- Duplicados descartados: ${duplicates.join(', ')}`);
  }

  return rows;
}

function main(): void {
  const rows = buildCatalog();
  const byType = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.type] = (acc[r.type] ?? 0) + 1;
    return acc;
  }, {});

  const values = rows
    .map((r) => `  (${lit(r.id)}, ${lit(r.brand)}, ${lit(r.model)}, ${lit(r.type)}, NULL)`)
    .join(',\n');

  process.stdout.write(`-- Catálogo global de vehículos: ${BRANDS.length} marcas, ${rows.length} modelos.
-- Reparto por tipo: ${Object.entries(byType)
    .map(([t, n]) => `${t}=${n}`)
    .join(', ')}.
--
-- GENERADO por scripts/gen-vehicle-catalog.ts — NO editar a mano. Para cambiar
-- el catálogo: editar scripts/data/vehicle-brands.ts y scripts/data/vehicle-types.ts,
-- re-correr el generador y agregar una migración NUEVA (append-only).
--
-- \`tenant_id NULL\` = global: visible en todos los estacionamientos y read-only
-- vía API (ningún endpoint del tenant puede editarlos ni borrarlos).
--
-- Los ids son UUIDv5 determinísticos sobre el namespace
-- ${NAMESPACE} y la clave "marca|modelo" en minúsculas,
-- salvo Toyota/Corolla, Ford/Ranger y Renault/Kangoo, que conservan los ids
-- 'aaaaaaaa-…aaa1/2/3' que ya publicaba el seed viejo.
--
-- NO se pasa \`sync_seq\`: la columna tiene DEFAULT nextval('vehicles_sync_seq').
-- Pasarlo a mano es el bug que ya tuvo que reparar 20260604024720_fix_sync_seq_zero.sql.
--
-- ON CONFLICT DO NOTHING SIN conflict target: cubre tanto la colisión por \`id\`
-- (re-corrida de la migración) como la de vehicles_scope_brand_model_uidx (una
-- fila global cargada a mano con la misma marca/modelo y otro id). Con
-- \`ON CONFLICT (id)\` ese segundo caso tiraría 23505 y voltearía la migración.
--
-- DO NOTHING y no DO UPDATE: un UPDATE dispara set_vehicles_sync_fields, que
-- bumpea sync_seq y version de las ${rows.length} filas y fuerza un re-pull completo
-- del catálogo en todos los clientes offline.

INSERT INTO vehicles (id, brand, model, type, tenant_id) VALUES
${values}
ON CONFLICT DO NOTHING;
`);
}

main();
