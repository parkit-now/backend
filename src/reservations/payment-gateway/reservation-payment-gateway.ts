/**
 * Puerto del cobro de reservas. El resto del módulo habla sólo con esta
 * interfaz; detrás hay un fake (tests), el checkout de dev (local) y, desde la
 * fase 3, Mercado Pago Checkout Pro.
 */

/** Token de inyección: `@Inject(RESERVATION_PAYMENT_GATEWAY)`. */
export const RESERVATION_PAYMENT_GATEWAY = Symbol(
  'RESERVATION_PAYMENT_GATEWAY',
);

export type CreateCheckoutInput = {
  reservation: { id: string };
  tenantId: string;
  amountArs: number;
  /** Hasta cuándo se puede pagar (fin de la retención). */
  expiresAt: Date;
  /** A dónde vuelve el conductor después de pagar. */
  returnUrl: string;
  /**
   * Con qué se arma el título que ve el comprador en el checkout. Lleva el
   * nombre del estacionamiento y el horario, nunca la patente ni datos del
   * conductor (el título lo ve Mercado Pago y el vendedor).
   */
  description: {
    parkingName: string;
    entryAt: Date;
    exitAt: Date;
  };
};

export type CheckoutResult = {
  preferenceId: string;
  checkoutUrl: string;
};

export type RefundInput = {
  tenantId: string;
  providerPaymentId: string;
  /** Sin monto, reembolso total. */
  amountArs?: number;
  /** Estable por intento: `refund:<reservationId>:<n>`. */
  idempotencyKey: string;
};

export type RefundResult = {
  /** `pending`: el proveedor lo aceptó pero todavía no lo confirmó. */
  status: 'refunded' | 'pending';
  amountArs: number;
};

export type CancelPendingInput = {
  tenantId: string;
  reservationId: string;
  providerPreferenceId?: string | null;
};

/**
 * Estado del pago normalizado. `partially_refunded` es un estado propio (y no
 * `approved` + `refundedAmountArs > 0`) para que quien despacha no tenga que
 * acordarse de mirar el monto: un `switch` sobre `status` alcanza, y tratar un
 * pago parcialmente devuelto como un `approved` cualquiera (confirmar la
 * reserva otra vez) es justo el error que esto evita. `pending` incluye lo que
 * Mercado Pago llama `in_process`.
 */
export type ProviderPaymentStatus =
  | 'approved'
  | 'partially_refunded'
  | 'pending'
  | 'rejected'
  | 'cancelled'
  | 'refunded';

export type ProviderPayment = {
  providerPaymentId: string;
  status: ProviderPaymentStatus;
  statusDetail?: string;
  /** Lo cobrado. */
  amountArs: number;
  /** Lo devuelto hasta ahora (0 si nada): con `partially_refunded`, el parcial. */
  refundedAmountArs: number;
  /** El id de la reserva con el que se creó el cobro; `null` si no vino. */
  externalReference: string | null;
};

export interface ReservationPaymentGateway {
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult>;
  /** Tira si el proveedor rechaza el pedido; el caller marca el reembolso `failed`. */
  refund(input: RefundInput): Promise<RefundResult>;
  /** Invalida un checkout que nadie pagó. No tira por un checkout inexistente. */
  cancelPending(input: CancelPendingInput): Promise<void>;
  getPayment(input: {
    tenantId: string;
    providerPaymentId: string;
  }): Promise<ProviderPayment>;
  /**
   * El pago aprobado de la reserva, si existe, buscándolo en el proveedor por
   * la reserva y no por el id de pago. Es la red del barrido: un webhook
   * perdido deja una reserva `pending_payment` que en realidad se pagó. `null`
   * si no hay ninguno (o si el proveedor no puede buscar).
   */
  findApprovedPayment(input: {
    tenantId: string;
    reservationId: string;
  }): Promise<ProviderPayment | null>;
}
