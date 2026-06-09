import { ApiProperty } from '@nestjs/swagger';
import { CashSessionDto } from './cash-session.dto';

export class CloseCashSessionResponseDto {
  @ApiProperty({ type: () => CashSessionDto })
  closedSession: CashSessionDto;

  @ApiProperty({ type: () => CashSessionDto })
  newSession: CashSessionDto;

  @ApiProperty({
    type: Number,
    description: 'Number of active entries reassigned to the new session.',
  })
  carriedOverCount: number;
}
