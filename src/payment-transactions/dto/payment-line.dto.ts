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
}
