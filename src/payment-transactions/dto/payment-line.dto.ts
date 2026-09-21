import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethodType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class PaymentLineDto {
  @ApiProperty({
    description: 'Client-generated UUIDv7 for offline-first support.',
    format: 'uuid',
  })
  @IsUUID()
  id: string;

  @ApiPropertyOptional({
    description: 'Payment method ID (may be absent if PM was deleted).',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  paymentMethodId?: string;

  @ApiProperty({ example: 'Efectivo', maxLength: 120 })
  @IsString()
  @MaxLength(120)
  paymentMethodName: string;

  /**
   * OPCIONAL a propósito, aunque la columna sea NOT NULL.
   *
   * Es opcional para no romper a los desktops que todavía no se actualizaron:
   * si lo exigiéramos, un cliente viejo recibiría 400 al cerrar un egreso y el
   * operador perdería el cobro. Cuando no viene, el backend lo resuelve por
   * `paymentMethodId` contra `payment_methods` y, en última instancia, lo
   * infiere del nombre (ver `resolvePaymentLineTypes` en entries.service.ts).
   *
   * Cuando SÍ viene, gana: es el snapshot, el tipo que el operador tenía en
   * pantalla al cobrar. Mismo criterio que `paymentMethodName`, que tampoco se
   * pisa con el nombre actual del método.
   */
  @ApiPropertyOptional({
    description:
      'Payment method type at the time of the charge (snapshot). Resolved server-side from paymentMethodId when omitted, for older clients.',
    enum: PaymentMethodType,
    enumName: 'PaymentMethodType',
    example: PaymentMethodType.cash,
  })
  @IsOptional()
  @IsEnum(PaymentMethodType)
  paymentMethodType?: PaymentMethodType;

  @ApiProperty({ type: Number, minimum: 0 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount: number;

  /**
   * El `payment_intent` de Mercado Pago que financia ESTA línea.
   *
   * VA EN LA LÍNEA Y NO EN EL BODY porque una estadía se puede pagar dividida
   * —$2.000 en efectivo y $3.000 con QR es un cobro de todos los días— y el
   * intent pertenece a UNA de esas partes, no al cierre. Colgarlo de la raíz
   * obligaría a adivinar contra qué línea validar el monto, y adivinar mal
   * significa aceptar un intent de $5.000 contra una línea de $2.000.
   *
   * Cuando viene, `closeEntry` lo quema dentro de la MISMA transacción que
   * cierra la estadía (`approved` → `consumed`). Cuando no viene —el 99% de los
   * cierres, que son en efectivo— no se toca `payment_intents` ni con una
   * query: el camino de cobro de las playas que no usan Mercado Pago queda
   * exactamente como estaba.
   *
   * NO es el `mp_order_id` de Mercado Pago: es NUESTRO id (UUIDv7, el mismo que
   * el desktop generó al apretar "Cobrar con QR" y que viajó a MP como
   * `external_reference`).
   */
  @ApiPropertyOptional({
    description:
      'Mercado Pago payment intent that funds THIS line. When present, closeEntry burns it (approved -> consumed) in the same transaction that closes the entry.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  paymentIntentId?: string;
}
