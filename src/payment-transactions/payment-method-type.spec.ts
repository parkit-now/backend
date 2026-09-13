import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PaymentMethodType } from '@prisma/client';
import { inferPaymentMethodTypeFromName } from './payment-method-type';

/**
 * Test de regresión del fix DE FONDO del arqueo de caja
 * (20260913200901_payment_transactions_method_type_snapshot.sql).
 *
 * POR QUÉ ESTE ARCHIVO EXISTE
 *
 * Este bug ya se "arregló" una vez, renombrando los métodos del sistema a
 * 'Efectivo'/'Transferencia' para que el match por nombre diera true. Ese fix
 * se mergeó sin un solo assert que avisara si volvía: revirtiendo la migración
 * las tres suites seguían verdes. Un fix sobre el camino del dinero sin test
 * de regresión no está terminado.
 *
 * Lo que se protege acá es el CONTRATO de la migración, porque el resto del
 * sistema descansa sobre él:
 *
 *   * que la columna quede NOT NULL — el desktop hace `type === 'cash'` sin
 *     ramas justamente porque toda fila del servidor tiene tipo;
 *   * que NO tenga DEFAULT — un 'other' por omisión reintroduce el bug en
 *     silencio, esta vez sin ningún nombre que lo delate;
 *   * que el backfill resuelva primero por `payment_method_id` — si alguien
 *     "simplifica" dejando sólo la heurística, todo cobro con un método
 *     renombrado a "Caja" se backfillea como 'other' y la plata desaparece de
 *     cajas ya cerradas;
 *   * que la heurística del SQL y la de TypeScript digan LO MISMO. Son dos
 *     copias de la misma regla en dos lenguajes; si divergen, una fila
 *     backfilleada y una fila nueva con los mismos datos se cuentan distinto.
 *
 * Leer el archivo SQL desde un test es raro, sí. La alternativa —levantar
 * Supabase en CI— hoy no existe (el pipeline mockea Prisma, ver AGENTS.md §8).
 * El mismo criterio que `entities/system-payment-methods.spec.ts`.
 */

/** La raíz del repo desde `src/payment-transactions/`. */
const REPO_ROOT = join(__dirname, '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');
const MIGRATION_SUFFIX = '_payment_transactions_method_type_snapshot.sql';

function typeSnapshotMigration(): string {
  const file = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(MIGRATION_SUFFIX))
    .sort()
    .pop();
  if (!file) {
    throw new Error(
      `No existe la migración *${MIGRATION_SUFFIX} en ${MIGRATIONS_DIR}. ` +
        'Si se renombró o se squasheó, actualizá este test: lo que NO puede ' +
        'pasar es que el snapshot del tipo desaparezca sin que nada avise.',
    );
  }
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
}

/** Sólo el SQL, sin los comentarios `--`, para no matchear contra la prosa. */
function statements(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('inferPaymentMethodTypeFromName', () => {
  it('reconoce el efectivo sin importar mayúsculas ni lo que venga pegado', () => {
    expect(inferPaymentMethodTypeFromName('Efectivo')).toBe('cash');
    expect(inferPaymentMethodTypeFromName('EFECTIVO')).toBe('cash');
    expect(inferPaymentMethodTypeFromName('Efectivo caja chica')).toBe('cash');
  });

  it('reconoce la transferencia', () => {
    expect(inferPaymentMethodTypeFromName('Transferencia')).toBe('transfer');
    expect(inferPaymentMethodTypeFromName('Transferencia Galicia')).toBe(
      'transfer',
    );
  });

  it('todo lo demás cae en other, que es el default seguro', () => {
    expect(inferPaymentMethodTypeFromName('Tarjeta de débito')).toBe('other');
    expect(inferPaymentMethodTypeFromName('Mercado Pago')).toBe('other');
    expect(inferPaymentMethodTypeFromName('')).toBe('other');
  });

  describe('sus límites, documentados a propósito', () => {
    // Estos dos casos NO son bugs de esta función: son la razón por la que la
    // función quedó relegada a último recurso y por la que existe la columna
    // `payment_method_type`. Se testean para que queden escritos y para que
    // nadie "arregle" la heurística creyendo que puede ser exacta.
    it('un efectivo llamado "Caja" se le escapa (falso negativo)', () => {
      expect(inferPaymentMethodTypeFromName('Caja')).toBe('other');
      expect(inferPaymentMethodTypeFromName('Contado')).toBe('other');
    });

    it('un "Efectivo Mercado Pago" type=other se lo traga (falso positivo)', () => {
      expect(inferPaymentMethodTypeFromName('Efectivo Mercado Pago')).toBe(
        'cash',
      );
    });
  });
});

describe('la migración del snapshot de tipo', () => {
  it('agrega la columna con el enum de payment_methods, no con un texto libre', () => {
    expect(statements(typeSnapshotMigration())).toMatch(
      /ADD COLUMN IF NOT EXISTS payment_method_type payment_method_type/i,
    );
  });

  it('la deja NOT NULL', () => {
    // Es lo que le permite al desktop hacer `type === 'cash'` sin ramas.
    expect(statements(typeSnapshotMigration())).toMatch(
      /ALTER COLUMN payment_method_type SET NOT NULL/i,
    );
  });

  it('NO le pone DEFAULT: sería el bug de nuevo, en silencio', () => {
    // Con un DEFAULT 'other', un insert que se olvide de la columna escribe un
    // tipo equivocado sobre un cobro en efectivo y nadie se entera.
    expect(statements(typeSnapshotMigration())).not.toMatch(
      /payment_method_type[^;]*DEFAULT/i,
    );
  });

  it('backfillea primero por payment_method_id, que es la pasada EXACTA', () => {
    // Sin esta pasada, un cobro cuyo método se llama "Caja" se backfillearía
    // como 'other' y desaparecería de una caja ya cerrada.
    const sql = statements(typeSnapshotMigration());
    expect(sql).toMatch(/SET payment_method_type = pm\.type/i);
    expect(sql).toMatch(/FROM payment_methods pm/i);
    expect(sql).toMatch(/pt\.payment_method_id = pm\.id/i);
    // Multi-tenant: el JOIN también ata el tenant.
    expect(sql).toMatch(/pt\.tenant_id = pm\.tenant_id/i);
  });

  it('la pasada heurística sólo toca lo que quedó sin resolver', () => {
    const sql = statements(typeSnapshotMigration());
    const heuristic =
      /SET payment_method_type = CASE[\s\S]*?WHERE payment_method_type IS NULL;/i.exec(
        sql,
      );
    expect(heuristic).not.toBeNull();
  });

  it('la heurística del SQL dice lo mismo que la de TypeScript', () => {
    // Dos copias de la misma regla en dos lenguajes. Si divergen, una fila
    // backfilleada y una fila nueva con los mismos datos se cuentan distinto,
    // y el arqueo deja de cerrar por una razón que nadie va a encontrar.
    const sql = statements(typeSnapshotMigration());

    const cases: Array<[string, PaymentMethodType]> = [
      ['efectivo', PaymentMethodType.cash],
      ['transferencia', PaymentMethodType.transfer],
    ];
    for (const [needle, expected] of cases) {
      expect(sql).toMatch(
        new RegExp(
          `LIKE '%${needle}%'\\s+THEN '${expected}'::payment_method_type`,
          'i',
        ),
      );
      expect(inferPaymentMethodTypeFromName(needle)).toBe(expected);
    }

    // Y el resto cae en 'other', igual que el `return` final de la función.
    expect(sql).toMatch(/ELSE 'other'::payment_method_type/i);
    expect(inferPaymentMethodTypeFromName('cualquier otra cosa')).toBe('other');

    // El SQL compara en minúsculas, igual que la función.
    expect(sql).toMatch(/lower\(payment_method_name\)/i);
  });
});
