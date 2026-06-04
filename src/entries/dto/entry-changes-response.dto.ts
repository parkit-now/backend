import { ApiProperty } from '@nestjs/swagger';
import { EntryDto } from './entry.dto';

export class EntryChangesResponseDto {
  @ApiProperty({ type: () => [EntryDto] })
  items: EntryDto[];

  @ApiProperty({
    description: 'Highest sync sequence included in this page.',
    type: Number,
  })
  maxSeq: number;
}
