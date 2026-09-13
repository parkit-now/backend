import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  SYSTEM_PAYMENT_METHOD_DEFAULTS,
  cashSystemPaymentMethod,
  isCashMethodName,
} from './system-payment-methods';

/**
 * Test de regresión del rename de los métodos de pago del sistema a español
 * (20260913163737_payment_methods_spanish_default_names.sql).
 *
 * QUÉ PROTEGE, Y POR QUÉ NO ALCANZABA CON LO QUE HABÍA
 *
 * El bug era de PLATA: el arqueo de caja del desktop decide qué cobro es
 * efectivo por el NOMBRE (`isCashMethod`), no por el `type`. Con el default
 * llamado `'cash'` el efectivo nunca se contaba. La migración lo arregla en
 * tres lugares —el trigger, `payment_methods` y el snapshot
 * `payment_transactions.payment_method_name`— pero revertir cualquiera de los
 * tres dejaba las tres suites en verde: no había un solo assert que mirara el
 * SQL.
 *
 * Estos tests leen el ARCHIVO de migración. Sí, un test que lee SQL es raro;
 * la alternativa —levantar Supabase en CI— hoy no existe (el pipeline mockea
 * Prisma, ver AGENTS.md §8) y el bloqueo real es que nadie pueda revertir esto
 * en silencio. Cuando haya smoke de migraciones en CI, esto se reemplaza por
 * un test de integración contra el trigger de verdad.
 */

/**
 * La raíz del repo desde `src/entities/`. `__dirname` y no `import.meta.url`:
 * el tsconfig compila a CommonJS (module nodenext + package.json sin
 * "type": "module"), y `tsc --noEmit` rechaza `import.meta` ahí (TS1470).
 */
const REPO_ROOT = join(__dirname, '..', '..');

const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');

const MIGRATION_SUFFIX = '_payment_methods_spanish_default_names.sql';

function spanishNamesMigration(): string {
  const file = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(MIGRATION_SUFFIX))
    .sort()
    .pop();
  if (!file) {
    throw new Error(
      `No existe la migración *${MIGRATION_SUFFIX} en ${MIGRATIONS_DIR}. ` +
        'Si se renombró o se squasheó, actualizá este test: lo que NO puede ' +
        'pasar es que los nombres en español desaparezcan sin que nada avise.',
    );
  }
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
}

/** El cuerpo del `INSERT INTO payment_methods` de `bootstrap_tenant_defaults()`. */
function bootstrapPaymentMethodsInsert(sql: string): string {
  const match =
    /INSERT INTO payment_methods[\s\S]*?ON CONFLICT DO NOTHING;/.exec(sql);
  if (!match) {
    throw new Error(
      'La migración ya no tiene un `INSERT INTO payment_methods ... ON ' +
        'CONFLICT DO NOTHING;` dentro de bootstrap_tenant_defaults(). Es el ' +
        'único lugar donde nacen los métodos del sistema.',
    );
  }
  return match[0];
}

/** Las sentencias `UPDATE <tabla> SET <columna> = ...` del backfill. */
function backfilledNames(sql: string, table: string, column: string): string[] {
  const pattern = new RegExp(
    `UPDATE ${table}\\s+SET ${column} = '([^']+)'`,
    'g',
  );
  return [...sql.matchAll(pattern)].map((m) => m[1]);
}

describe('system-payment-methods', () => {
  describe('la regla del arqueo', () => {
    it('el default de efectivo lo reconoce isCashMethod del desktop', () => {
      // ESTE es el assert que importa. `'cash'.toLowerCase().includes('efectivo')`
      // da false: con el nombre técnico, cada cobro en efectivo sumaba $0 al
      // esperado en caja y aparecía como "otros medios".
      expect(isCashMethodName(cashSystemPaymentMethod().name)).toBe(true);
    });

    it('ningún default queda con el nombre técnico del enum', () => {
      for (const method of SYSTEM_PAYMENT_METHOD_DEFAULTS) {
        expect(method.name.toLowerCase()).not.toBe(method.type);
      }
    });

    it('el default de transferencia NO se cuenta como efectivo', () => {
      const transfer = SYSTEM_PAYMENT_METHOD_DEFAULTS.find(
        (m) => m.type === 'transfer',
      );
      expect(transfer).toBeDefined();
      expect(isCashMethodName(transfer!.name)).toBe(false);
    });
  });

  describe('la migración sigue sembrando lo mismo que la constante', () => {
    it('bootstrap_tenant_defaults() inserta los nombres en español', () => {
      const insert = bootstrapPaymentMethodsInsert(spanishNamesMigration());

      for (const { type, name } of SYSTEM_PAYMENT_METHOD_DEFAULTS) {
        // `(NEW.id, 'cash', 'Efectivo', ...)`: el par tipo→nombre, junto.
        expect(insert).toMatch(new RegExp(`'${type}'\\s*,\\s*'${name}'`, 'i'));
      }
    });

    it('el trigger no siembra un nombre de efectivo que el arqueo no reconozca', () => {
      const insert = bootstrapPaymentMethodsInsert(spanishNamesMigration());
      const cashRow = /'cash'\s*,\s*'([^']+)'/.exec(insert);

      expect(cashRow).not.toBeNull();
      expect(isCashMethodName(cashRow![1])).toBe(true);
    });
  });

  describe('el backfill llega a las DOS tablas', () => {
    it('renombra los payment_methods ya existentes', () => {
      const names = backfilledNames(
        spanishNamesMigration(),
        'payment_methods',
        'name',
      );

      for (const { name } of SYSTEM_PAYMENT_METHOD_DEFAULTS) {
        expect(names).toContain(name);
      }
    });

    it('renombra el SNAPSHOT payment_transactions.payment_method_name', () => {
      // El arqueo NO lee `payment_methods`: lee esta columna desnormalizada,
      // copiada al cobrar. Sin este backfill el rename arregla los cobros
      // futuros y deja mal contado todo lo ya cobrado — y una caja abierta en
      // el momento del deploy cierra con los dos criterios mezclados.
      const names = backfilledNames(
        spanishNamesMigration(),
        'payment_transactions',
        'payment_method_name',
      );

      for (const { name } of SYSTEM_PAYMENT_METHOD_DEFAULTS) {
        expect(names).toContain(name);
      }
      expect(names.some((name) => isCashMethodName(name))).toBe(true);
    });

    it('el backfill no pisa los métodos renombrados a mano por el dueño', () => {
      // El `WHERE ... = '<nombre técnico>'` es lo que hace que "Efectivo caja
      // chica" o "Transferencia Galicia" queden intactos. Sin ese filtro el
      // backfill uniformaría una decisión del usuario.
      const sql = spanishNamesMigration();

      for (const { type } of SYSTEM_PAYMENT_METHOD_DEFAULTS) {
        expect(sql).toMatch(
          new RegExp(`WHERE payment_method_name = '${type}'`, 'i'),
        );
        expect(sql).toMatch(new RegExp(`AND name = '${type}'`, 'i'));
      }
    });
  });

  describe('el seed local no reintroduce los nombres técnicos', () => {
    // Ya pasó: `scripts/seed-tenant.ts` tenía el array inline con
    // 'cash'/'transfer' y en cada `make seed-all` revertía la migración sin
    // que nadie se enterara. Ahora importa la constante; este test impide que
    // vuelva a haber una segunda fuente de verdad.
    const seedScript = readFileSync(
      join(REPO_ROOT, 'scripts', 'seed-tenant.ts'),
      'utf8',
    );

    it('importa SYSTEM_PAYMENT_METHOD_DEFAULTS en vez de listar los nombres', () => {
      expect(seedScript).toContain('SYSTEM_PAYMENT_METHOD_DEFAULTS');
    });

    it('no tiene los nombres técnicos escritos como literales de nombre', () => {
      expect(seedScript).not.toMatch(/\[\s*'transfer'\s*,\s*'transfer'/);
      expect(seedScript).not.toMatch(/\[\s*'cash'\s*,\s*'cash'/);
    });
  });
});
