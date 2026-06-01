import { ApiProperty } from '@nestjs/swagger';
import { RateDto } from './rate.dto';

export class RateChangesResponseDto {
  @ApiProperty({ type: () => [RateDto] })
  items: RateDto[];

  @ApiProperty({
    description: 'Highest sync sequence included in this page.',
    type: Number,
  })
  maxSeq: number;
}
