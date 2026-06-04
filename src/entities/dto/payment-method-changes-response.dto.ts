import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethodSummaryDto } from './entity-profile.dto';

export class PaymentMethodChangesResponseDto {
  @ApiProperty({ type: [PaymentMethodSummaryDto] })
  items: PaymentMethodSummaryDto[];

  @ApiProperty({
    type: Number,
    description:
      'Highest syncSeq in the returned batch. Pass as afterSeq on the next poll.',
  })
  maxSeq: number;
}
