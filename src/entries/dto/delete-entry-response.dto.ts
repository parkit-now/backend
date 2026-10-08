import { ApiProperty } from '@nestjs/swagger';
import { EntryDto } from './entry.dto';
import { PaymentTransactionDto } from '../../payment-transactions/dto/payment-transaction.dto';

export class DeleteEntryResponseDto {
  @ApiProperty({ type: EntryDto })
  entry: EntryDto;

  @ApiProperty({ type: [PaymentTransactionDto] })
  deletedPaymentTransactions: PaymentTransactionDto[];
}
