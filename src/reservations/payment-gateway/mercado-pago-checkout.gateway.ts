import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  MpApiClient,
  type MpPayment,
  type MpPreferenceBody,
} from '../../mercado-pago/mp-api.client';
import { MpTokenService } from '../../mercado-pago/mp-token.service';
import { ErrorCodes } from '../../utils/exceptions/error-codes';
import { FormattedException } from '../../utils/exceptions/http-exception/formatted-exeption';
import {
  type CancelPendingInput,
  type CheckoutResult,
  type CreateCheckoutInput,
  type ProviderPayment,
  type ProviderPaymentStatus,
  type RefundInput,
  type RefundResult,
  type ReservationPaymentGateway,
} from './reservation-payment-gateway';

const TIME_ZONE = 'America/Argentina/Buenos_Aires';

/**
 * Tope del título del ítem. Mercado Pago no lo documenta para las preferencias
 * (sí son 150 en Orders), así que se usa ese como cota conservadora: pasarse
 * hace que la preferencia se rechace entera y el conductor no pueda pagar.
 * TODO(prod-check): confirmar el tope real de `items[].title` en Checkout Pro.
 */
const MAX_TITLE_LENGTH = 150;

/**
 * Argentina no tiene horario de verano desde 2009: el offset es fijo. Mercado
 * Pago pide ISO 8601 con milisegundos y offset (`2026-10-10T08:00:00.000-03:00`).
 * TODO(prod-check): confirmar que acepta `Z` también; se manda -03:00 porque es
 * lo que muestran todos los ejemplos de la documentación.
 */
const AR_OFFSET_MS = -3 * 60 * 60 * 1000;

/**
 * Cuentas del vendedor sin token usable: el reembolso no se puede hacer hasta
 * que el dueño vuelva a vincular Mercado Pago. El mensaje termina en
 * `reservation.refundError` (lo ve el dueño), por eso va en español y dice qué
 * hacer.
 */
const TOKEN_UNUSABLE_MESSAGES: Partial<Record<string, string>> = {
  [ErrorCodes.MP_ACCOUNT_TOKEN_EXPIRED]:
    'La vinculación con Mercado Pago venció. Volvé a vincular la cuenta para poder reembolsar.',
  [ErrorCodes.MP_ACCOUNT_REVOKED]:
    'La cuenta de Mercado Pago fue desvinculada o revocó el acceso. Volvé a vincularla para poder reembolsar.',
  [ErrorCodes.MP_NOT_LINKED]:
    'El estacionamiento no tiene una cuenta de Mercado Pago vinculada. Vinculala para poder reembolsar.',
};

/**
 * Cobro de reservas con Mercado Pago Checkout Pro. Cada llamada pide un token
 * vivo del dueño del estacionamiento (`getUsableAccessToken`: refresca si
 * hace falta) y la plata va directo a su cuenta: no hay comisión del
 * marketplace (`marketplace_fee: 0`).
 *
 * Los errores de `MpApiClient` (`FormattedException`) se dejan pasar tal cual en
 * `createCheckout`, `getPayment` y `findApprovedPayment`: quien llama decide
 * (503 al conductor, reintento del webhook, etc.). `refund` los traduce a un
 * `Error` con mensaje en español porque termina en `refundError`, y
 * `cancelPending` no tira nunca.
 */
export class MercadoPagoCheckoutGateway implements ReservationPaymentGateway {
  private readonly logger = new Logger(MercadoPagoCheckoutGateway.name);

  constructor(
    private readonly api: MpApiClient,
    private readonly tokens: MpTokenService,
    /** URL pública del backend, sin `/` final (ver `resolvePublicApiUrl`). */
    private readonly publicApiUrl: string,
    /** Inyectable para que el body de la preferencia sea determinístico en tests. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
    const { accessToken } = await this.tokens.getUsableAccessToken(
      input.tenantId,
    );
    const body = this.buildPreference(input);

    const preference = await this.api.createPreference(
      accessToken,
      body,
      preferenceIdempotencyKey(body),
    );
    return { preferenceId: preference.id, checkoutUrl: preference.initPoint };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    let accessToken: string;
    try {
      ({ accessToken } = await this.tokens.getUsableAccessToken(
        input.tenantId,
      ));
    } catch (error) {
      const message = tokenUnusableMessage(error);
      if (message) throw new Error(message);
      throw error;
    }

    const refund = await this.api.refundPayment(
      accessToken,
      input.providerPaymentId,
      input.idempotencyKey,
      input.amountArs,
    );
    return {
      // Solo `approved` es plata devuelta; cualquier otro estado queda
      // `pending` y el barrido lo confirma leyendo el pago.
      status: refund.status === 'approved' ? 'refunded' : 'pending',
      amountArs: refund.amount ?? input.amountArs ?? 0,
    };
  }

  /**
   * Cancela los pagos de la reserva que todavía no se resolvieron
   * (`pending` / `in_process`), para que un pago a medio hacer no se acredite
   * después de que la reserva se cerró. Nunca tira: si no se puede (token,
   * MP caído, la búsqueda tarda en indexar) se loguea y se sigue; el pago
   * tardío lo cubre el webhook + reembolso.
   */
  async cancelPending(input: CancelPendingInput): Promise<void> {
    try {
      const { accessToken } = await this.tokens.getUsableAccessToken(
        input.tenantId,
      );
      const payments = await this.api.searchPayments(accessToken, {
        externalReference: input.reservationId,
      });
      for (const payment of payments) {
        if (payment.status !== 'pending' && payment.status !== 'in_process') {
          continue;
        }
        try {
          await this.api.cancelPayment(
            accessToken,
            payment.id,
            `cancel-payment:${payment.id}`,
          );
        } catch (error) {
          this.logger.warn(
            `No se pudo cancelar el pago ${payment.id} de la reserva ${input.reservationId}: ${describe(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `No se pudieron cancelar los pagos pendientes de la reserva ${input.reservationId}: ${describe(error)}`,
      );
    }
  }

  async getPayment(input: {
    tenantId: string;
    providerPaymentId: string;
  }): Promise<ProviderPayment> {
    const { accessToken } = await this.tokens.getUsableAccessToken(
      input.tenantId,
    );
    const payment = await this.api.getPayment(
      accessToken,
      input.providerPaymentId,
    );
    return toProviderPayment(payment);
  }

  async findApprovedPayment(input: {
    tenantId: string;
    reservationId: string;
  }): Promise<ProviderPayment | null> {
    const { accessToken } = await this.tokens.getUsableAccessToken(
      input.tenantId,
    );
    const payments = await this.api.searchPayments(accessToken, {
      externalReference: input.reservationId,
    });
    // Un pago que se cobró y se devolvió (parcial o total) igual prueba que la
    // reserva se pagó; el más nuevo primero (lo ordena la búsqueda).
    for (const payment of payments) {
      const mapped = toProviderPayment(payment);
      if (
        mapped.status === 'approved' ||
        mapped.status === 'partially_refunded'
      ) {
        return mapped;
      }
    }
    return null;
  }

  private buildPreference(input: CreateCheckoutInput): MpPreferenceBody {
    const returnBase = `${this.publicApiUrl}/payments/mp/return?reservation=${encodeURIComponent(input.reservation.id)}`;
    return {
      items: [
        {
          title: buildTitle(input.description),
          quantity: 1,
          unit_price: input.amountArs,
          currency_id: 'ARS',
        },
      ],
      external_reference: input.reservation.id,
      // `source_news=webhooks`: que MP mande solo Webhooks (firmados) y no IPN.
      // TODO(prod-check): la documentación solo describe `source_news=ipn`
      // (recibir solo IPN); `webhooks` es su complemento pero no está escrito.
      // Si MP lo ignorara, llegarían IPN sin firma: el webhook las responde 200
      // y las descarta, así que no rompe nada, solo habría que revisar que lleguen
      // las notificaciones firmadas.
      notification_url: `${this.publicApiUrl}/integrations/mercadopago/webhook?source_news=webhooks`,
      // Sin `pending`: el pago o se aprueba o se rechaza en el momento.
      binary_mode: true,
      // Nada de pago en efectivo: tarda días y la retención dura minutos.
      payment_methods: { excluded_payment_types: [{ id: 'ticket' }] },
      expires: true,
      expiration_date_from: toArgentinaIso(this.now()),
      expiration_date_to: toArgentinaIso(input.expiresAt),
      back_urls: {
        success: `${returnBase}&result=success`,
        failure: `${returnBase}&result=failure`,
        pending: `${returnBase}&result=pending`,
      },
      auto_return: 'approved',
      marketplace_fee: 0,
    };
  }
}

/**
 * `Reserva <Parking> · <dd/mm> <hh:mm>–<hh:mm>` en hora argentina. El nombre
 * del estacionamiento es lo único que se recorta, para que la fecha y la hora
 * (lo que identifica la reserva) nunca se pierdan. Sin patente ni nombre del
 * conductor: el título lo ven Mercado Pago y el vendedor.
 */
export function buildTitle(
  description: CreateCheckoutInput['description'],
): string {
  const day = formatInArgentina(description.entryAt, {
    day: '2-digit',
    month: '2-digit',
  }).replace(/\s/g, '');
  const from = formatTime(description.entryAt);
  const to = formatTime(description.exitAt);
  const prefix = 'Reserva ';
  const suffix = ` · ${day} ${from}–${to}`;
  const room = MAX_TITLE_LENGTH - prefix.length - suffix.length;
  const name = description.parkingName.trim().slice(0, Math.max(room, 0));
  return `${prefix}${name}${suffix}`;
}

function formatTime(date: Date): string {
  return formatInArgentina(date, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

function formatInArgentina(
  date: Date,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: TIME_ZONE,
    ...options,
  }).format(date);
}

function toArgentinaIso(date: Date): string {
  return new Date(date.getTime() + AR_OFFSET_MS)
    .toISOString()
    .replace('Z', '-03:00');
}

/**
 * Huella del body entero (patrón de `posIdempotencyKey`): el mismo pedido da
 * la misma key, y cualquier campo distinto da otra, que es lo que evita el
 * `409 idempotency_key_already_used` de misma key con body distinto.
 * `expiration_date_from` lleva la hora de pedido, así que un reintento tardío
 * pide una preferencia nueva en vez de reutilizar una vieja.
 */
function preferenceIdempotencyKey(body: MpPreferenceBody): string {
  return createHash('sha256')
    .update(`create-preference:${JSON.stringify(body)}`)
    .digest('hex');
}

/**
 * Mapeo de estados de Mercado Pago a los del puerto.
 *
 *  - `approved` sin devoluciones → `approved`
 *  - `approved` con devolución parcial (`partially_refunded`) → `partially_refunded`
 *  - `refunded` (o devuelto el monto entero) → `refunded`
 *  - `rejected` / `cancelled` → igual
 *  - `pending`, `in_process`, `authorized`, `in_mediation` y lo desconocido
 *    (p. ej. `charged_back`, fuera del MVP) → `pending`: no dispara ninguna
 *    transición, se queda en el `providerStatus` crudo.
 */
function toProviderPayment(payment: MpPayment): ProviderPayment {
  const amount = payment.transactionAmount ?? 0;
  const refunded = payment.transactionAmountRefunded ?? 0;

  return {
    providerPaymentId: payment.id,
    status: mapStatus(payment.status, amount, refunded),
    ...(payment.statusDetail ? { statusDetail: payment.statusDetail } : {}),
    amountArs: amount,
    refundedAmountArs: refunded,
    externalReference: payment.externalReference,
  };
}

function mapStatus(
  status: string | null,
  amount: number,
  refunded: number,
): ProviderPaymentStatus {
  switch (status) {
    case 'approved':
      if (refunded <= 0) return 'approved';
      return amount > 0 && refunded >= amount
        ? 'refunded'
        : 'partially_refunded';
    case 'refunded':
      return 'refunded';
    case 'rejected':
      return 'rejected';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

function tokenUnusableMessage(error: unknown): string | null {
  if (!(error instanceof FormattedException)) return null;
  const code = (error.getResponse() as { code?: string }).code;
  return code ? (TOKEN_UNUSABLE_MESSAGES[code] ?? null) : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'error desconocido';
}
