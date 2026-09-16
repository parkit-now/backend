import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RateDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: Number })
  hourPriceArs: number;

  @ApiProperty({ type: Number })
  stayPriceArs: number;

  @ApiProperty({ type: Number })
  fractionPriceArs: number;

  @ApiProperty({ type: Number })
  mediaEstadiaPriceArs: number;

  @ApiProperty()
  autoFractionPrice: boolean;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty({ type: Number, nullable: true })
  shortcutNumber: number | null;

  @ApiProperty({ type: Number })
  version: number;

  @ApiProperty({ type: Number })
  syncSeq: number;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Non-null when the rate has been soft-deleted. Rows with a non-null ' +
      'value only ever appear in GET /rates/changes, as a tombstone telling ' +
      'offline clients to drop the rate from their local copy.',
  })
  deletedAt: Date | null;
}
