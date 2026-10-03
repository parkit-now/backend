import {
  type CancelPendingInput,
  type CheckoutResult,
  type CreateCheckoutInput,
  type ProviderPayment,
  type RefundInput,
  type RefundResult,
  type ReservationPaymentGateway,
} from './reservation-payment-gateway';

/**
 * Gateway de pruebas: sin red, deterministico y con las llamadas registradas.
 * Los tests le piden fallar o contestar `pending` con los campos `next*`.
 */
export class FakeReservationPaymentGateway implements ReservationPaymentGateway {
  readonly checkouts: CreateCheckoutInput[] = [];
  readonly refunds: RefundInput[] = [];
  readonly cancelled: CancelPendingInput[] = [];

  /** Si está, `createCheckout` tira este error. */
  nextCheckoutError: Error | null = null;
  /** Si está, `refund` tira este error. */
  nextRefundError: Error | null = null;
  /** Respuesta de `refund`; por defecto el reembolso queda confirmado. */
  nextRefundStatus: RefundResult['status'] = 'refunded';
  /** Respuesta de `getPayment`. */
  nextPayment: ProviderPayment | null = null;

  createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
    this.checkouts.push(input);
    if (this.nextCheckoutError) return Promise.reject(this.nextCheckoutError);
    return Promise.resolve({
      preferenceId: `fake-pref-${input.reservation.id}`,
      checkoutUrl: `https://fake.checkout/${input.reservation.id}`,
    });
  }

  refund(input: RefundInput): Promise<RefundResult> {
    this.refunds.push(input);
    if (this.nextRefundError) return Promise.reject(this.nextRefundError);
    return Promise.resolve({
      status: this.nextRefundStatus,
      amountArs: input.amountArs ?? 0,
    });
  }

  cancelPending(input: CancelPendingInput): Promise<void> {
    this.cancelled.push(input);
    return Promise.resolve();
  }

  getPayment(input: {
    tenantId: string;
    providerPaymentId: string;
  }): Promise<ProviderPayment> {
    return Promise.resolve(
      this.nextPayment ?? {
        providerPaymentId: input.providerPaymentId,
        status: 'approved',
        amountArs: 0,
      },
    );
  }
}
