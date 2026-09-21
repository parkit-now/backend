import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentIntentStatus } from '@prisma/client';
import { IsNumber, IsPositive, IsUUID, Max } from 'class-validator';

/**
 * Techo del monto de un intento de cobro, en pesos.
 *
 * No es una regla de negocio de estacionamientos: es un cortafuegos contra un
 * bug del motor de cobro que manda un monto absurdo. Sin techo, un error de
 * cálculo (un timestamp usado como precio, digamos) llega hasta Mercado Pago y
 * genera un QR por una fortuna, y el único que se entera es el cliente parado
 * frente al cartel. Diez millones de pesos está órdenes de magnitud por encima
 * de cualquier estadía real y órdenes de magnitud por debajo de un timestamp.
 */
export const MAX_PAYMENT_INTENT_AMOUNT = 10_000_000;

/** Body de `POST /tenants/:tenantId/payment-intents`. */
export class CreatePaymentIntentDto {
  /**
   * 🔴 EL `id` LO GENERA EL CLIENTE, y eso es lo que hace idempotente al
   * endpoint.
   *
   * Mismo patrón que `Entry` y `CashSession`: un UUIDv7 armado por el desktop.
   * No es capricho offline-first acá, es la única forma de que un reintento
   * sea reconocible. Si el `id` lo generara el servidor, un POST que se corta
   * por timeout dejaría al desktop sin saber si la fila existe, y el reintento
   * crearía un SEGUNDO intento —y una segunda orden en Mercado Pago— para la
   * misma salida. Con el `id` del cliente, el reintento trae el mismo y el
   * service devuelve el intento que ya estaba.
   *
   * Además viaja a Mercado Pago como `external_reference`: 36 caracteres de
   * hex y guiones, dentro del máximo de 64 y del charset que MP acepta, y SIN
   * un solo dato personal adentro.
   */
  @ApiProperty({
    description:
      'Client-generated UUIDv7, same convention as entries and cash sessions. Re-sending the same id returns the existing payment intent instead of creating a second one, which is what makes this endpoint safe to retry after a timeout.',
    format: 'uuid',
    example: '018f44f7-9a96-7f75-9e9c-44ed9432fc12',
  })
  @IsUUID()
  id: string;

  @ApiProperty({
    description:
      'Stay being charged. It must belong to `:tenantId` and still be open (no exit registered).',
    format: 'uuid',
    example: '018f44f7-1111-7f75-9e9c-44ed9432fc12',
  })
  @IsUUID()
  entryId: string;

  /**
   * El monto se CONGELA con la fila y no se recalcula nunca: la recuperación
   * de un intento en `created` re-POSTea el mismo body a Mercado Pago con la
   * misma `X-Idempotency-Key`, y un monto recalculado —aunque sea por un
   * minuto más de estadía— cambia el body y devuelve
   * `409 idempotency_key_already_used` en vez de la orden original.
   */
  @ApiProperty({
    description:
      'Amount to charge, in ARS, frozen at creation time and never recalculated: the recovery path re-posts the exact same body to Mercado Pago under the same idempotency key.',
    type: Number,
    minimum: 0.01,
    maximum: MAX_PAYMENT_INTENT_AMOUNT,
    example: 1500,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_PAYMENT_INTENT_AMOUNT)
  amount: number;
}

/**
 * Un intento de cobro con QR, tal como lo ve el desktop.
 *
 * ## Qué NO sale acá, y por qué
 *
 * Nada de la cuenta de Mercado Pago: ni el access token, ni el refresh token,
 * ni siquiera el `mp_user_id` o el `external_pos_id`. Este DTO habla de UN
 * cobro; las credenciales y la caja viven en `MpAccountDto`, que ya tiene su
 * propio criterio escrito. Mezclarlas acá sería publicar el tablero de la
 * integración en un endpoint que el operario poolea cada cinco segundos.
 *
 * Por eso el mapper (`toPaymentIntentDto`) lista los campos UNO POR UNO en vez
 * de hacer spread del modelo de Prisma: con spread, una columna nueva se
 * publica sola, en silencio, en el próximo `db:generate`, y el diff del PR ni
 * toca este archivo. Es el mismo razonamiento de `toMpAccountDto`.
 */
export class PaymentIntentDto {
  @ApiProperty({
    description: 'Identifier of the payment intent (client-generated UUIDv7).',
    format: 'uuid',
    example: '018f44f7-9a96-7f75-9e9c-44ed9432fc12',
  })
  id: string;

  @ApiProperty({
    description: 'Entity (parking lot / tenant) this charge belongs to.',
    format: 'uuid',
    example: '11111111-1111-7111-8111-111111111111',
  })
  tenantId: string;

  @ApiProperty({
    description: 'Stay being charged.',
    format: 'uuid',
    example: '018f44f7-1111-7f75-9e9c-44ed9432fc12',
  })
  entryId: string;

  @ApiProperty({
    description:
      'Our own state, the one that drives behaviour. `created` means the row exists but the Mercado Pago order may or may not; `pending` means the order exists and is waiting for the customer to scan; `approved` means Mercado Pago credited the payment and it still has to be turned into a transaction. Everything else is terminal.',
    enum: PaymentIntentStatus,
    enumName: 'PaymentIntentStatus',
    example: PaymentIntentStatus.pending,
  })
  status: PaymentIntentStatus;

  @ApiProperty({
    description:
      'Amount to charge, in ARS. Frozen when the intent was created.',
    type: Number,
    example: 1500,
  })
  amount: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Identifier of the order on the Mercado Pago side. Null between the insert and the answer of `POST /v1/orders` — and it stays null when that call died on a timeout and we do not know whether the order exists.',
    example: '01HRYF6XN0ABCD1234567890',
  })
  mpOrderId: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Raw `status` reported by Mercado Pago, untranslated. Diagnostics only: the state that drives behaviour is `status`.',
    example: 'processed',
  })
  mpStatus: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Raw `status_detail` reported by Mercado Pago. Diagnostics only.',
    example: 'accredited',
  })
  mpStatusDetail: string | null;

  @ApiProperty({
    description:
      'When this intent stops being usable. Computed once at creation from the same TTL sent to Mercado Pago as `expiration_time`.',
    format: 'date-time',
    example: '2026-09-21T03:05:00.000Z',
  })
  expiresAt: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'date-time',
    description:
      'When Mercado Pago credited the payment. It is the instant reported by Mercado Pago, not ours.',
    example: '2026-09-21T03:02:11.000Z',
  })
  approvedAt: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'date-time',
    description:
      'When the intent was turned into a payment transaction and closed the stay.',
    example: null,
  })
  consumedAt: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'The transaction this intent produced when it was consumed.',
    example: null,
  })
  paymentTransactionId: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Why it failed, free text for humans. Never carries tokens or payer personal data.',
    example: null,
  })
  failureReason: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'uuid',
    description:
      'Operator who ordered the charge. Null when the row was written by the webhook or the reconciler, or when that user was deleted.',
    example: '22222222-2222-7222-8222-222222222222',
  })
  createdByUserId: string | null;

  @ApiProperty({ format: 'date-time', example: '2026-09-21T03:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-21T03:00:01.000Z' })
  updatedAt: string;
}
