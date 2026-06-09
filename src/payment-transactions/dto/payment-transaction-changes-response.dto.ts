import { ApiProperty } from '@nestjs/swagger';
import { PaymentTransactionDto } from './payment-transaction.dto';

export class PaymentTransactionChangesResponseDto {
  @ApiProperty({ type: () => [PaymentTransactionDto] })
  items: PaymentTransactionDto[];

  @ApiProperty({
    description: 'Highest sync sequence included in this page.',
    type: Number,
  })
  maxSeq: number;
}
