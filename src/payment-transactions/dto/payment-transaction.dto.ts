import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethodType } from '@prisma/client';

export class PaymentTransactionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty({ format: 'uuid' })
  entryId: string;

  @ApiPropertyOptional({ format: 'uuid' })
  cashSessionId: string | null;

  @ApiPropertyOptional({ format: 'uuid' })
  paymentMethodId: string | null;

  @ApiProperty({ example: 'Efectivo' })
  paymentMethodName: string;

  /**
   * El campo del que depende el arqueo de caja del desktop. Sin esto el cierre
   * tiene que adivinar qué es efectivo mirando `paymentMethodName`, y eso se
   * rompe en cuanto el dueño renombra su método.
   */
  @ApiProperty({
    description:
      'Payment method type at the time of the charge (snapshot). The desktop cash count keys off this, never off the name.',
    enum: PaymentMethodType,
    enumName: 'PaymentMethodType',
    example: PaymentMethodType.cash,
  })
  paymentMethodType: PaymentMethodType;

  @ApiProperty({ type: Number })
  amount: number;

  @ApiProperty({ type: Number })
  version: number;

  @ApiProperty({ type: Number })
  syncSeq: number;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  deletedAt: string | null;
}
