import type { PaymentMethodType } from '@prisma/client';
import { inferPaymentMethodTypeFromName } from '../payment-transactions/payment-method-type';

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
 * Si la heurística por nombre daría 'cash'.
 *
 * OJO CON LO QUE ESTO SIGNIFICA HOY, QUE YA NO ES LO DE ANTES
 *
 * Hasta `20260913200901_payment_transactions_method_type_snapshot.sql` esta
 * regla ERA el arqueo de caja: el desktop decidía qué cobro entró al cajón
 * buscando "efectivo" en `payment_transactions.payment_method_name`. Por eso
 * el nombre del default no era cosmética — un método de efectivo llamado
 * `'cash'` hacía que el esperado en caja diera de menos.
 *
 * Ya no. El cobro ahora snapshotea el TIPO (`payment_method_type`) y el arqueo
 * mira eso. La regla por nombre quedó relegada a último recurso, para filas
 * sin tipo y sin método vivo que consultar (ver
 * `inferPaymentMethodTypeFromName`, que es de dónde sale esta función: una
 * sola fuente de verdad para la heurística).
 *
 * Entonces, ¿por qué los defaults siguen teniendo que llamarse "Efectivo" y
 * "Transferencia", y por qué el spec lo sigue atando? Por dos razones, las dos
 * vigentes:
 *
 *   1. Es lo que el usuario VE — en pantalla, en el ticket y en el arqueo. Un
 *      método que dice "cash" en una app en español es un default mal elegido.
 *   2. Es el único salvavidas que le queda a una fila legacy: un cobro viejo,
 *      sin tipo, cuyo método ya no existe. Si el default vuelve a llamarse
 *      'cash', esas filas se backfillean como 'other' y la plata desaparece.
 */
export function isCashMethodName(name: string): boolean {
  return inferPaymentMethodTypeFromName(name) === 'cash';
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
