import { randomUUID } from 'node:crypto';
import {
  type CheckoutResult,
  type CreateCheckoutInput,
  type ProviderPayment,
  type RefundInput,
  type RefundResult,
  type ReservationPaymentGateway,
} from './reservation-payment-gateway';

/** Prefijo del id de un pago de dev cuyo reembolso tiene que fallar. */
export const DEV_FAILING_PAYMENT_PREFIX = 'devfail_';
export const DEV_PAYMENT_PREFIX = 'dev_';

/**
 * Id de pago que genera el checkout de dev al aprobar. El flag de "reembolso
 * fallido" viaja en el prefijo (`devfail_`) y no en memoria: sobrevive a un
 * reinicio del backend.
 */
export function devPaymentId(failRefund: boolean): string {
  return `${failRefund ? DEV_FAILING_PAYMENT_PREFIX : DEV_PAYMENT_PREFIX}${randomUUID()}`;
}

/**
 * Checkout falso para probar todo en local (Mercado Pago no tiene sandbox
 * útil). El `checkoutUrl` apunta a una página de la propia API
 * (`GET /dev/checkout/:reservationId`) con los botones Aprobar / Rechazar. El
 * reembolso se confirma al instante, salvo que el id del pago empiece con
 * `devfail_`: ahí tira, para probar la alerta de reembolso fallido.
 *
 * NUNCA se registra en producción (ver `reservation-payment.provider.ts`).
 */
export class DevCheckoutGateway implements ReservationPaymentGateway {
  constructor(private readonly baseUrl: string = defaultBaseUrl()) {}

  createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
    return Promise.resolve({
      preferenceId: `dev_pref_${input.reservation.id}`,
      checkoutUrl: `${this.baseUrl}/dev/checkout/${input.reservation.id}`,
    });
  }

  refund(input: RefundInput): Promise<RefundResult> {
    if (input.providerPaymentId.startsWith(DEV_FAILING_PAYMENT_PREFIX)) {
      return Promise.reject(
        new Error('Dev checkout: reembolso forzado a fallar (devfail_).'),
      );
    }
    return Promise.resolve({
      status: 'refunded',
      amountArs: input.amountArs ?? 0,
    });
  }

  cancelPending(): Promise<void> {
    return Promise.resolve();
  }

  getPayment(input: {
    tenantId: string;
    providerPaymentId: string;
  }): Promise<ProviderPayment> {
    return Promise.resolve({
      providerPaymentId: input.providerPaymentId,
      status: 'approved',
      amountArs: 0,
    });
  }
}

function defaultBaseUrl(): string {
  const configured = process.env.PUBLIC_API_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `http://localhost:${process.env.PORT ?? 3000}`;
}
