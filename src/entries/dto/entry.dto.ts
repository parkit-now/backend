import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class EntryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty({ example: 'ABC123', maxLength: 10 })
  plate: string;

  @ApiPropertyOptional({ example: 'Rojo', maxLength: 50 })
  color: string | null;

  @ApiProperty({ format: 'date-time' })
  enteredAt: Date;

  @ApiPropertyOptional({ format: 'date-time' })
  leftAt: Date | null;

  @ApiPropertyOptional({ type: Number })
  amountPaid: number | null;

  @ApiProperty({ format: 'uuid' })
  vehicleId: string;

  @ApiPropertyOptional({ format: 'uuid' })
  rateId: string | null;

  @ApiPropertyOptional()
  rateSnapshotName: string | null;

  @ApiPropertyOptional({ type: Number })
  rateSnapshotHourPriceArs: number | null;

  @ApiPropertyOptional({ type: Number })
  rateSnapshotStayPriceArs: number | null;

  @ApiPropertyOptional({ type: Number })
  rateSnapshotFractionPriceArs: number | null;

  @ApiProperty({ type: Number })
  version: number;

  @ApiProperty({ type: Number })
  syncSeq: number;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}
