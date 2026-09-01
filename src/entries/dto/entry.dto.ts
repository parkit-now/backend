import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VehicleBodyType } from '@prisma/client';

export class EntryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty({ example: 'ABC123', maxLength: 20 })
  plate: string;

  @ApiProperty({
    example: 'manual',
    description: 'auto = created by LPR; manual = operator-typed',
  })
  source: string;

  @ApiPropertyOptional({ enum: VehicleBodyType })
  vehicleType: VehicleBodyType | null;

  @ApiPropertyOptional({
    description: 'URL of the entry photo captured by the LPR camera',
  })
  entryImageUrl: string | null;

  @ApiPropertyOptional({ maxLength: 100 })
  entryCameraId: string | null;

  @ApiPropertyOptional()
  exitImageUrl: string | null;

  @ApiPropertyOptional({ maxLength: 100 })
  exitCameraId: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Set when entry was authorized via whitelist',
  })
  whitelistId: string | null;

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

  @ApiPropertyOptional({
    example: 'Volkswagen',
    description: 'Vehicle brand snapshot.',
  })
  vehicleBrand: string | null;

  @ApiPropertyOptional({
    example: 'Bora',
    description: 'Vehicle model snapshot.',
  })
  vehicleModel: string | null;

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

  @ApiPropertyOptional({ format: 'uuid' })
  cashSessionId: string | null;

  @ApiPropertyOptional({ type: Number })
  ticketNumber: number | null;

  @ApiProperty({ type: Number })
  version: number;

  @ApiProperty({ type: Number })
  syncSeq: number;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}
