import { ApiProperty } from '@nestjs/swagger';
import { InvoiceDto } from './invoice.dto';

export class InvoiceChangesResponseDto {
  @ApiProperty({ type: () => [InvoiceDto] })
  items: InvoiceDto[];

  @ApiProperty({
    description: 'Highest sync sequence included in this page.',
    type: Number,
  })
  maxSeq: number;
}
