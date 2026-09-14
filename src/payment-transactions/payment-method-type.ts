import { PaymentMethodType } from '@prisma/client';

/**
 * La heurística de ÚLTIMO RECURSO para deducir el tipo de un medio de pago a
 * partir de su nombre.
 *
 * CUÁNDO SE USA, Y SÓLO CUÁNDO
 *
 * `payment_transactions` guarda el tipo del medio como snapshot
 * (`payment_method_type`, ver
 * 20260913200901_payment_transactions_method_type_snapshot.sql). Ese valor se
 * resuelve, en este orden:
 *
 *   1. Lo que mandó el cliente en la línea de pago (es el snapshot: refleja lo
 *      que el operador tenía en pantalla al cobrar).
 *   2. `payment_methods.type`, buscado por `paymentMethodId`. Exacto.
 *   3. ESTA función.
 *
 * O sea: (3) sólo corre cuando un cliente VIEJO —uno que todavía no manda el
 * tipo— cobra con un método cuyo id ya no existe en `payment_methods`. Es el
 * mismo universo que backfilleó la migración, y por la misma razón: cuando el
 * único rastro del medio es el nombre que se copió ese día, el nombre es lo
 * mejor que hay.
 *
 * LA REGLA ES, A PROPÓSITO, LA REGLA VIEJA DEL DESKTOP
 *
 * Antes el arqueo entero decidía así (`isCashMethod` en
 * front-desktop/src/features/entries/entryUtils.ts). Estaba mal como regla
 * general: rompe si el dueño renombra su método a "Caja" y se traga un
 * `type='other'` llamado "Efectivo Mercado Pago". Pero acotada a las filas sin
 * mejor información es conservadora — reproduce exactamente el número que el
 * arqueo venía mostrando, así que ningún cierre ya firmado cambia.
 *
 * SU LÍMITE, explícito:
 *   * "Caja", "Contado", "Mostrador" -> `other`, aunque fuera efectivo.
 *   * "Efectivo Mercado Pago" -> `cash`, aunque la plata haya ido a MP.
 *
 * Los dos casos necesitan id nulo o colgado Y un nombre que miente. Hacia
 * adelante no pasa nunca: el tipo viaja explícito en cada cobro.
 *
 * NO AGREGAR ACÁ UNA RAMA PARA `mercadopago_qr`
 *
 * El enum tiene desde 20260914011821 un valor `mercadopago_qr` para el cobro
 * con el QR de Mercado Pago. La tentación evidente es sumar
 * `if (normalized.includes('mercado pago')) return 'mercadopago_qr'`. Sería un
 * error, y de los que no se ven:
 *
 * Esta función SÓLO corre sobre filas VIEJAS —cobros sin tipo, con el método
 * ya borrado— y esas filas son, por definición, anteriores a la integración.
 * Un "Mercado Pago" ahí es un método propio (`other`) que alguien creó a mano
 * para anotar una transferencia por fuera del sistema: esa plata nunca pasó
 * por el QR. Reclasificarla movería cobros entre categorías de arqueos YA
 * CERRADOS, que es exactamente lo que el snapshot de tipo vino a evitar. El
 * spec deja asentado el comportamiento actual: 'Mercado Pago' -> 'other'.
 *
 * El cobro real con QR no necesita ninguna heurística: nace con
 * `paymentMethodType = 'mercadopago_qr'` explícito, escrito por el backend
 * cuando el webhook confirma el pago. Eso se implementa en B5.
 */
export function inferPaymentMethodTypeFromName(
  name: string,
): PaymentMethodType {
  const normalized = name.toLowerCase();
  if (normalized.includes('efectivo')) return PaymentMethodType.cash;
  if (normalized.includes('transferencia')) return PaymentMethodType.transfer;
  return PaymentMethodType.other;
}
