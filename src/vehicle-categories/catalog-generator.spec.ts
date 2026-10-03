import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { VEHICLE_CATEGORIES } from './vehicle-categories';

/**
 * El generador de la plantilla del catálogo (scripts/gen-vehicle-catalog.ts)
 * emite la CATEGORÍA de cada modelo, no el nombre de un tipo. Se corre de
 * verdad (es puro: lee un JSON y escribe a stdout) y se mira el SQL.
 */
describe('gen-vehicle-catalog', () => {
  const result = spawnSync(
    process.execPath,
    [
      'run',
      join(__dirname, '../../scripts/gen-vehicle-catalog.ts'),
      '--with-backfill',
    ],
    { encoding: 'utf8' },
  );
  const sql = result.stdout;
  const rows = [
    ...sql.matchAll(/^ {2}\('((?:[^']|'')*)', '((?:[^']|'')*)', '(\w+)'\)/gm),
  ].map((m) => ({ brand: m[1], model: m[2], category: m[3] }));

  it('corre sin errores', () => {
    expect(result.status).toBe(0);
  });

  it('inserta (brand, model, category) y ya no type_name', () => {
    expect(sql).toContain(
      'INSERT INTO vehicle_catalog_defaults (brand, model, category) VALUES',
    );
    expect(sql).not.toContain('type_name');
  });

  it('todas las filas tienen una categoría válida', () => {
    expect(rows.length).toBeGreaterThan(1000);
    for (const row of rows) {
      expect(VEHICLE_CATEGORIES).toContain(row.category as never);
    }
  });

  it('los utilitarios salen como van y las pickups como pickup', () => {
    const find = (brand: string, model: string) =>
      rows.find((r) => r.brand === brand && r.model === model)?.category;
    expect(find('Renault', 'Kangoo')).toBe('van');
    expect(find('Toyota', 'Hilux')).toBe('pickup');
    expect(find('Toyota', 'Corolla')).toBe('car');
    expect(find('Toyota', 'RAV4')).toBe('suv');
  });

  it('el backfill de playas existentes resuelve el tipo por categoría', () => {
    expect(sql).toContain('resolve_tenant_vehicle_type(t.id, d.category)');
  });
});
