import type { PaymentMethodInvoiceMode } from '@prisma/client';

/**
 * Desde este monto, ARCA exige identificar al receptor aun siendo consumidor
 * final. Sin receptor, la factura queda pendiente (el tope lo actualiza ARCA:
 * revisarlo con el contador).
 */
export const CONSUMIDOR_FINAL_ID_THRESHOLD = 10_000_000;

export type InitialInvoiceDecision =
  | { readonly kind: 'issue' }
  | { readonly kind: 'pending'; readonly reason?: 'INVOICE_RECEIVER_REQUIRED' }
  | { readonly kind: 'not_required' };

/**
 * Qué hacer con la factura de una estadía recién cobrada, según el
 * `invoice_mode` del medio de cada línea de pago:
 *
 * - monto 0 o ninguna línea de un medio marcado → no se factura;
 * - todas las líneas en `auto` → se emite ya;
 * - alguna marcada pero no todas en `auto` → queda pendiente para el Historial;
 * - consumidor final desde $10.000.000 → pendiente hasta identificar receptor.
 *
 * Una línea sin medio (cliente viejo, medio borrado) cuenta como `none`.
 */
export function resolveInitialInvoice(input: {
  readonly total: number;
  readonly lineModes: readonly PaymentMethodInvoiceMode[];
}): InitialInvoiceDecision {
  if (!(input.total > 0)) return { kind: 'not_required' };
  if (!input.lineModes.some((mode) => mode !== 'none')) {
    return { kind: 'not_required' };
  }
  if (input.total >= CONSUMIDOR_FINAL_ID_THRESHOLD) {
    return { kind: 'pending', reason: 'INVOICE_RECEIVER_REQUIRED' };
  }
  if (input.lineModes.every((mode) => mode === 'auto')) {
    return { kind: 'issue' };
  }
  return { kind: 'pending' };
}
