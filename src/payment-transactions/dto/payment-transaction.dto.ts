import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  @ApiProperty({ type: Number })
  amount: number;

  @ApiProperty({ type: Number })
  version: number;

  @ApiProperty({ type: Number })
  syncSeq: number;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}
