import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AuditActions } from '../audit/audit.service';
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

const NAMES_MIGRATION_SUFFIX = '_payment_methods_spanish_default_names.sql';
const DEFAULT_MIGRATION_SUFFIX = '_payment_methods_cash_is_default.sql';

function migrationBySuffix(suffix: string): string {
  const file = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .pop();
  if (!file) {
    throw new Error(
      `No existe la migración *${suffix} en ${MIGRATIONS_DIR}. ` +
        'Si se renombró o se squasheó, actualizá este test: lo que NO puede ' +
        'pasar es que el contrato del trigger cambie sin que nada avise.',
    );
  }
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
}

function spanishNamesMigration(): string {
  return migrationBySuffix(NAMES_MIGRATION_SUFFIX);
}

/**
 * La migración que mueve `is_default` a Efectivo. Es la ÚLTIMA que reescribe
 * `bootstrap_tenant_defaults()`, así que es la que manda sobre lo que siembra
 * hoy el trigger.
 */
function cashIsDefaultMigration(): string {
  return migrationBySuffix(DEFAULT_MIGRATION_SUFFIX);
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

  describe('el default del trigger es Efectivo', () => {
    /**
     * Una fila del `INSERT ... VALUES` del trigger, partida en sus columnas:
     * `(NEW.id, 'cash', 'Efectivo', true, true, true)`.
     */
    function seededRow(sql: string, type: string): string {
      const row = new RegExp(`\\(NEW\\.id,\\s*'${type}'[^)]*\\)`).exec(
        bootstrapPaymentMethodsInsert(sql),
      );
      if (!row) {
        throw new Error(
          `El INSERT de bootstrap_tenant_defaults() ya no siembra '${type}'.`,
        );
      }
      return row[0];
    }

    it('siembra is_default en el mismo método que dice la constante', () => {
      // El assert que cierra el triángulo constante ↔ trigger ↔ seed. Sin él,
      // dar vuelta el default en un solo lado deja las tres suites en verde y
      // el desktop arranca preseleccionando otra cosa que el backend.
      const sql = cashIsDefaultMigration();

      for (const { type, isDefault } of SYSTEM_PAYMENT_METHOD_DEFAULTS) {
        const columns = seededRow(sql, type)
          .split(',')
          .map((column) => column.trim().replace(/\)$/, ''));
        // (NEW.id, type, name, enabled, is_system, is_default) → la última.
        expect(columns.at(-1)).toBe(String(isDefault));
      }
    });

    it('el preseleccionado es el que el arqueo cuenta como efectivo', () => {
      const preseleccionado = SYSTEM_PAYMENT_METHOD_DEFAULTS.find(
        (method) => method.isDefault,
      );
      expect(preseleccionado).toBeDefined();
      expect(preseleccionado!.type).toBe('cash');
      expect(isCashMethodName(preseleccionado!.name)).toBe(true);
    });

    it('el CREATE OR REPLACE no se comió el resto del bootstrap', () => {
      // `CREATE OR REPLACE FUNCTION` reemplaza el cuerpo ENTERO. Reescribirla
      // para tocar los métodos de pago y copiar de menos deja a cada
      // estacionamiento nuevo sin tipos de vehículo, sin catálogo o sin
      // servicios, y no se nota hasta que alguien da de alta una playa.
      const sql = cashIsDefaultMigration();

      expect(sql).toContain('INSERT INTO vehicle_types');
      expect(sql).toContain('FROM vehicle_type_defaults');
      expect(sql).toContain('INSERT INTO vehicles');
      expect(sql).toContain('FROM vehicle_catalog_defaults');
      expect(sql).toContain('INSERT INTO services');
      expect(sql).toContain("'ADVANCE_RESERVATION'");
    });

    it('el backfill no le da vuelta el default a quien ya lo eligió', () => {
      // Mismo criterio que el backfill del rename: sólo entran los tenants que
      // siguen exactamente como los dejó el trigger. Si el dueño movió el
      // default a mano —a Efectivo, a Transferencia o a un método propio—, su
      // elección se respeta.
      const sql = cashIsDefaultMigration();

      expect(sql).toMatch(/UPDATE payment_methods/);
      // La condición de "configuración original": transfer prendido, cash
      // apagado y ninguna otra fila del tenant marcada como default.
      expect(sql).toMatch(/type = 'transfer'\s+AND pm\.is_default/);
      expect(sql).toMatch(/type = 'cash'\s+AND NOT pm\.is_default/);
      expect(sql).toMatch(/NOT EXISTS/);
      // Y no escribe filas que ya tienen el valor: sin esto el UPDATE bumpea
      // `version`/`sync_seq` de filas que no cambiaron y manda ruido al sync.
      expect(sql).toMatch(/is_default IS DISTINCT FROM/);
    });

    it('el backfill consulta el rastro de auditoría con la acción vigente', () => {
      // El estado de `payment_methods` NO distingue "nunca lo tocaron" de "el
      // dueño eligió transferencia": es la misma fila. Lo único que los separa
      // es el registro que deja `togglePaymentMethod`. Si alguien renombra la
      // acción auditada y no actualiza la migración, ese NOT EXISTS deja de
      // encontrar nada y el backfill vuelve a pisar decisiones, en silencio.
      const sql = cashIsDefaultMigration();

      expect(sql).toContain(AuditActions.PAYMENT_METHOD_TOGGLED);
      expect(sql).toMatch(/audit_log/);
      expect(sql).toMatch(/metadata ->> 'isDefault'/);
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
