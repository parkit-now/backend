import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  inferCategoryFromName,
  normalizeVehicleTypeName,
  RESERVABLE_VEHICLE_CATEGORIES,
  VEHICLE_CATEGORIES,
  VEHICLE_CATEGORY_ALIASES,
  VEHICLE_CATEGORY_INFO,
  type VehicleCategory,
} from './vehicle-categories';

const MIGRATION = readFileSync(
  join(
    __dirname,
    '../../supabase/migrations/20261005120000_vehicle_categories.sql',
  ),
  'utf8',
);

const RESERVATIONS_MIGRATION = readFileSync(
  join(
    __dirname,
    '../../supabase/migrations/20261005120300_reservations_vehicle_categories.sql',
  ),
  'utf8',
);

const PREVIEW = readFileSync(
  join(__dirname, '../../scripts/sql/preview-vehicle-categories.sql'),
  'utf8',
);

/** Filas `('a', 'b', ...)` de un bloque VALUES, sin parsear comentarios. */
function rows(sql: string): string[][] {
  return [...sql.matchAll(/^\s*\(([^()\n]+)\)[,;]?\s*$/gm)].map((m) =>
    m[1].split(',').map((c) => c.trim().replace(/^'|'$/g, '')),
  );
}

/** Alias `('nombre', 'categoria')` del CTE `alias(nombre, category)` de un SQL. */
function aliasesIn(sql: string): Record<string, string> {
  const block = sql.slice(sql.indexOf('alias(nombre, category) AS ('));
  const entries: [string, string][] = rows(block)
    .filter((r) => r.length === 2)
    .map((r) => [r[0], r[1]]);
  return Object.fromEntries(entries);
}

describe('categorías de vehículo', () => {
  describe('inferCategoryFromName', () => {
    it.each([
      ['Auto', 'car'],
      ['Autos', 'car'],
      ['AUTOMÓVIL', 'car'],
      ['SUV', 'suv'],
      ['Pick-up', 'pickup'],
      ['PICKUP', 'pickup'],
      ['pick up', 'pickup'],
      ['Utilitario', 'van'],
      ['Utilitario / Van', 'van'],
      ['utilitarios', 'van'],
      ['Van', 'van'],
      ['Furgón', 'van'],
      ['Furgoneta', 'van'],
      ['MOTOS', 'motorcycle'],
      ['Moto', 'motorcycle'],
      ['Bici', 'bicycle'],
      ['Bicicleta', 'bicycle'],
      ['Camion', 'truck'],
      ['Camión', 'truck'],
      ['Otro', 'other'],
      ['  Otros  ', 'other'],
    ])('%s -> %s', (name, expected) => {
      expect(inferCategoryFromName(name)).toBe(expected as VehicleCategory);
    });

    it.each(['Camioneta', 'pepe', '', 'Auto grande'])(
      '%j no se reconoce -> null',
      (name) => {
        expect(inferCategoryFromName(name)).toBeNull();
      },
    );
  });

  it('normalizeVehicleTypeName pliega acentos y quita símbolos', () => {
    expect(normalizeVehicleTypeName(' Pick-Up ')).toBe('pickup');
    expect(normalizeVehicleTypeName('Utilitario / Van')).toBe('utilitariovan');
    expect(normalizeVehicleTypeName('Camión')).toBe('camion');
    expect(normalizeVehicleTypeName('4x4')).toBe('4x4');
  });

  it('todo alias apunta a una categoría de la lista', () => {
    for (const category of Object.values(VEHICLE_CATEGORY_ALIASES)) {
      expect(VEHICLE_CATEGORIES).toContain(category);
    }
  });

  describe('paridad con la migración 20261005120000', () => {
    it('las categorías, su etiqueta, orden y si son reservables', () => {
      const seeded = rows(
        MIGRATION.slice(MIGRATION.indexOf('INSERT INTO vehicle_categories')),
      )
        .filter((r) => r.length === 4)
        .slice(0, VEHICLE_CATEGORY_INFO.length);

      expect(seeded).toEqual(
        VEHICLE_CATEGORY_INFO.map((c) => [
          c.code,
          c.label,
          String(c.sortOrder),
          String(c.reservable),
        ]),
      );
      expect(VEHICLE_CATEGORY_INFO.map((c) => c.code)).toEqual([
        ...VEHICLE_CATEGORIES,
      ]);
    });

    it('RESERVABLE_VEHICLE_CATEGORIES son exactamente las reservable = true', () => {
      expect([...RESERVABLE_VEHICLE_CATEGORIES] as string[]).toEqual(
        VEHICLE_CATEGORY_INFO.filter((c) => c.reservable).map((c) => c.code),
      );
    });

    it('el CHECK de services.reservation_vehicle_categories son las reservables', () => {
      const check = RESERVATIONS_MIGRATION.match(
        /<@ ARRAY\[([^\]]+)\]::text\[\]/,
      );
      expect(check).not.toBeNull();
      const fromSql = (check?.[1] ?? '')
        .split(',')
        .map((c) => c.trim().replace(/^'|'$/g, ''));
      expect(fromSql).toEqual([...RESERVABLE_VEHICLE_CATEGORIES]);
    });

    it('la lista de alias del backfill es la misma que la del código', () => {
      expect(aliasesIn(MIGRATION)).toEqual(VEHICLE_CATEGORY_ALIASES);
    });

    it('el preview de sólo lectura usa los mismos alias', () => {
      expect(aliasesIn(PREVIEW)).toEqual(VEHICLE_CATEGORY_ALIASES);
    });
  });
});
