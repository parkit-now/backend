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

export type ProviderPaymentStatus =
  | 'approved'
  | 'pending'
  | 'rejected'
  | 'cancelled'
  | 'refunded';

export type ProviderPayment = {
  providerPaymentId: string;
  status: ProviderPaymentStatus;
  statusDetail?: string;
  amountArs: number;
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
}
