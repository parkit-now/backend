import type { PaymentMethodType } from '@prisma/client';

/**
 * Los métodos de pago DEL SISTEMA: los dos que toda entidad nueva trae puesta
 * y que su dueño puede renombrar o deshabilitar, pero no borrar (`is_system`).
 *
 * POR QUÉ ESTO EXISTE COMO CONSTANTE Y NO SÓLO ADENTRO DEL SQL
 *
 * El nombre de estos dos métodos se escribe desde TRES lugares que tienen que
 * decir exactamente lo mismo:
 *
 *   1. `bootstrap_tenant_defaults()` — el trigger AFTER INSERT ON tenants
 *      (20260913163737_payment_methods_spanish_default_names.sql). Es el único
 *      camino de alta real: los tres flujos de creación de tenants convergen
 *      ahí.
 *   2. `scripts/seed-tenant.ts` — el seed local, que además SOBRESCRIBE el
 *      `name` en cada corrida.
 *   3. Esta constante, que es la que consume (2) y contra la que testea
 *      `system-payment-methods.spec.ts`.
 *
 * Ya falló una vez: el seed traía los nombres técnicos y en cada `make
 * seed-all` revertía en silencio el rename de la migración. Con el array
 * inline en el script no había nada que se pusiera rojo. Ahora el seed importa
 * de acá y el spec ata esta constante contra el SQL de la migración.
 *
 * NO es la fuente de verdad en runtime: el backend nunca escribe estos
 * defaults, los escribe el trigger. Es la fuente de verdad del CONTRATO, para
 * que el seed y el test puedan verificar que el trigger sigue diciendo lo
 * mismo.
 */
export interface SystemPaymentMethodDefault {
  type: Extract<PaymentMethodType, 'transfer' | 'cash'>;
  name: string;
  isDefault: boolean;
}

/**
 * En el MISMO orden que el `INSERT ... VALUES` del trigger, para que la
 * comparación del spec sea directa.
 *
 * `is_default` es `transfer`: hoy el flujo de cobro arranca en transferencia.
 * Cambiarlo es otra decisión y tiene otro impacto; vive acá sólo para que el
 * seed no invente un tercer criterio.
 */
export const SYSTEM_PAYMENT_METHOD_DEFAULTS: readonly SystemPaymentMethodDefault[] =
  [
    { type: 'transfer', name: 'Transferencia', isDefault: true },
    { type: 'cash', name: 'Efectivo', isDefault: false },
  ] as const;

/**
 * Espejo EXACTO de `isCashMethod()` del desktop
 * (`front-desktop/src/features/entries/entryUtils.ts`):
 *
 *     export function isCashMethod(name: string): boolean {
 *       return name.toLowerCase().includes('efectivo');
 *     }
 *
 * El arqueo de caja decide qué cobro es efectivo con ESTA regla, aplicada
 * sobre `payment_transactions.payment_method_name` (el snapshot copiado al
 * cobrar), no sobre el `type`. Por eso el nombre del default no es cosmética:
 * un método de efectivo llamado `'cash'` hace que el esperado en caja dé de
 * menos y que el cobro aparezca como "otros medios".
 *
 * Se duplica acá a propósito, y no se importa del desktop: son dos paquetes
 * distintos sin código compartido. Lo que ata las dos copias es el test, que
 * falla si el backend deja de sembrar un nombre que el desktop reconozca.
 */
export function isCashMethodName(name: string): boolean {
  return name.toLowerCase().includes('efectivo');
}

/** El default de efectivo, el que el arqueo tiene que reconocer. */
export function cashSystemPaymentMethod(): SystemPaymentMethodDefault {
  const cash = SYSTEM_PAYMENT_METHOD_DEFAULTS.find((m) => m.type === 'cash');
  if (!cash) {
    throw new Error(
      'SYSTEM_PAYMENT_METHOD_DEFAULTS perdió el método de efectivo',
    );
  }
  return cash;
}
