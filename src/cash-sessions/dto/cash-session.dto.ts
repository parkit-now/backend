import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CashSessionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty({ format: 'date-time' })
  openedAt: Date;

  @ApiPropertyOptional({ format: 'date-time' })
  closedAt: Date | null;

  @ApiProperty({ type: Number, description: 'Opening cash float in ARS.' })
  openingCash: number;

  @ApiPropertyOptional({
    type: Number,
    description: 'Cash left for the next shift.',
  })
  leavingCash: number | null;

  @ApiPropertyOptional()
  notes: string | null;

  @ApiProperty({ type: Number })
  version: number;

  @ApiProperty({ type: Number })
  syncSeq: number;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}
