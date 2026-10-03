import { HttpStatus } from '@nestjs/common';
import { ErrorCodes } from '../../utils/exceptions/error-codes';
import { FormattedException } from '../../utils/exceptions/http-exception/formatted-exeption';
import {
  type CheckoutResult,
  type ProviderPayment,
  type RefundResult,
  type ReservationPaymentGateway,
} from './reservation-payment-gateway';

const INSTANCE = '/driver/reservations';

/**
 * Placeholder de Mercado Pago hasta la fase 3 (Checkout Pro): cobrar responde
 * 503 y el reembolso falla (queda `failed`, reintentable a mano).
 */
export class UnavailableMercadoPagoGateway implements ReservationPaymentGateway {
  createCheckout(): Promise<CheckoutResult> {
    return Promise.reject(
      new FormattedException(
        'Service Unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
        'Reservation payments are not available yet.',
        INSTANCE,
        ErrorCodes.RESERVATION_CHECKOUT_UNAVAILABLE,
      ),
    );
  }

  refund(): Promise<RefundResult> {
    return Promise.reject(
      new Error('Mercado Pago refunds are not available yet.'),
    );
  }

  cancelPending(): Promise<void> {
    return Promise.resolve();
  }

  getPayment(): Promise<ProviderPayment> {
    return Promise.reject(
      new Error('Mercado Pago payments are not available yet.'),
    );
  }

  findApprovedPayment(): Promise<ProviderPayment | null> {
    return Promise.resolve(null);
  }
}
