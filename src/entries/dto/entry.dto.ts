import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class EntryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty({ example: 'ABC123', maxLength: 20 })
  plate: string;

  @ApiPropertyOptional({ example: 'Rojo', maxLength: 50 })
  color: string | null;

  @ApiPropertyOptional({ example: 'Cochera 3', maxLength: 100 })
  cochera: string | null;

  @ApiPropertyOptional({ example: 'Cliente frecuente' })
  notes: string | null;

  @ApiProperty({ format: 'date-time' })
  enteredAt: Date;

  @ApiPropertyOptional({ format: 'date-time' })
  leftAt: Date | null;

  @ApiPropertyOptional({ type: Number })
  amountPaid: number | null;

  @ApiProperty({ format: 'uuid' })
  vehicleId: string;

  @ApiPropertyOptional({ example: 'Volkswagen', description: 'Vehicle brand.' })
  vehicleBrand: string | null;

  @ApiPropertyOptional({ example: 'Bora', description: 'Vehicle model.' })
  vehicleModel: string | null;

  @ApiPropertyOptional({
    example: 'ABC123',
    description: 'Vehicle plate as stored on the vehicle record.',
  })
  vehiclePlate: string | null;

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
