import { ApiProperty } from '@nestjs/swagger';
import { CashSessionDto } from './cash-session.dto';

export class CashSessionChangesResponseDto {
  @ApiProperty({ type: () => [CashSessionDto] })
  items: CashSessionDto[];

  @ApiProperty({
    description: 'Highest sync sequence included in this page.',
    type: Number,
  })
  maxSeq: number;
}
