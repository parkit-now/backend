import type { Provider } from '@nestjs/common';
import { isProduction } from '../../utils/env';
import { DevCheckoutGateway } from './dev-checkout.gateway';
import {
  RESERVATION_PAYMENT_GATEWAY,
  type ReservationPaymentGateway,
} from './reservation-payment-gateway';
import { UnavailableMercadoPagoGateway } from './unavailable-mercado-pago.gateway';

export type ReservationPaymentProviderName = 'dev' | 'mercado_pago';

/**
 * Elige el proveedor con `RESERVATION_PAYMENT_PROVIDER`. Por defecto `dev`
 * fuera de producción y `mercado_pago` en producción. En producción `dev` no se
 * puede registrar nunca: el arranque falla (es mejor no levantar que cobrar con
 * un checkout falso).
 */
export function resolveReservationPaymentProvider(
  configured: string | undefined = process.env.RESERVATION_PAYMENT_PROVIDER,
  production: boolean = isProduction(),
): ReservationPaymentProviderName {
  const value = configured?.trim();
  if (!value) return production ? 'mercado_pago' : 'dev';
  if (value !== 'dev' && value !== 'mercado_pago') {
    throw new Error(
      `RESERVATION_PAYMENT_PROVIDER inválido: '${value}' (dev | mercado_pago).`,
    );
  }
  if (value === 'dev' && production) {
    throw new Error(
      'RESERVATION_PAYMENT_PROVIDER=dev no está permitido con NODE_ENV=production.',
    );
  }
  return value;
}

export function createReservationPaymentGateway(
  provider: ReservationPaymentProviderName = resolveReservationPaymentProvider(),
): ReservationPaymentGateway {
  return provider === 'dev'
    ? new DevCheckoutGateway()
    : new UnavailableMercadoPagoGateway();
}

export const ReservationPaymentGatewayProvider: Provider = {
  provide: RESERVATION_PAYMENT_GATEWAY,
  useFactory: (): ReservationPaymentGateway =>
    createReservationPaymentGateway(),
};
