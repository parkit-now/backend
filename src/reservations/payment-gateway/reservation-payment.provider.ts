import type { Provider } from '@nestjs/common';
import { MpApiClient } from '../../mercado-pago/mp-api.client';
import { MpTokenService } from '../../mercado-pago/mp-token.service';
import { isProduction } from '../../utils/env';
import { DevCheckoutGateway } from './dev-checkout.gateway';
import {
  RESERVATION_PAYMENT_GATEWAY,
  type ReservationPaymentGateway,
} from './reservation-payment-gateway';
import { MercadoPagoCheckoutGateway } from './mercado-pago-checkout.gateway';

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

/**
 * `PUBLIC_API_URL` es la URL pública de ESTE backend. Con Checkout Pro la
 * necesita Mercado Pago para llamar al webhook y para devolver al comprador a
 * la página puente, así que sin ella el proveedor `mercado_pago` no puede
 * funcionar: el arranque falla (mismo criterio que `dev` en producción) en vez
 * de crear preferencias cuyo `notification_url` apunta a ningún lado.
 *
 * Se devuelve sin la `/` final: quien la usa arma `${url}/ruta`. En producción
 * tiene que ser HTTPS (Mercado Pago rechaza redirects sin cifrar); fuera de
 * producción se acepta `http` para probar con un túnel local.
 */
export function resolvePublicApiUrl(
  configured: string | undefined = process.env.PUBLIC_API_URL,
  production: boolean = isProduction(),
): string {
  const value = configured?.trim();
  if (!value) {
    throw new Error(
      'PUBLIC_API_URL es obligatoria con RESERVATION_PAYMENT_PROVIDER=mercado_pago ' +
        '(la URL pública del backend, para el webhook y el retorno del checkout).',
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`PUBLIC_API_URL no es una URL válida (valor: "${value}").`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !production)) {
    throw new Error(
      `PUBLIC_API_URL debe ser HTTPS en producción (valor: "${value}").`,
    );
  }
  return value.replace(/\/+$/, '');
}

export function createReservationPaymentGateway(
  provider: ReservationPaymentProviderName = resolveReservationPaymentProvider(),
  deps?: { api: MpApiClient; tokens: MpTokenService },
): ReservationPaymentGateway {
  if (provider === 'dev') return new DevCheckoutGateway();
  // Falla acá, en el arranque, si falta la URL pública.
  const publicApiUrl = resolvePublicApiUrl();
  if (!deps) {
    throw new Error(
      'El proveedor mercado_pago necesita MpApiClient y MpTokenService.',
    );
  }
  return new MercadoPagoCheckoutGateway(deps.api, deps.tokens, publicApiUrl);
}

export const ReservationPaymentGatewayProvider: Provider = {
  provide: RESERVATION_PAYMENT_GATEWAY,
  inject: [MpApiClient, MpTokenService],
  useFactory: (
    api: MpApiClient,
    tokens: MpTokenService,
  ): ReservationPaymentGateway =>
    createReservationPaymentGateway(undefined, { api, tokens }),
};
