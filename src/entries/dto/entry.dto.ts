import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VEHICLE_CATEGORY_API_PROPERTY } from '../../vehicle-categories/dto/vehicle-category.dto';
import type { VehicleCategory } from '../../vehicle-categories/vehicle-categories';

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

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 60,
    description:
      'Snapshot del nombre del tipo al momento del ingreso. Texto y no FK: un ' +
      'ingreso histórico no debe cambiar si el dueño renombra o borra el tipo. ' +
      'Desde las categorías también se llena en los ingresos manuales.',
  })
  vehicleType: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Tipo de vehículo elegido al ingresar. Sin FK en la base: puede ' +
      'apuntar a un tipo borrado (que sigue viajando por ' +
      '/vehicle-types/changes como tombstone). null en ingresos anteriores o ' +
      'de cajas viejas.',
  })
  vehicleTypeId: string | null;

  @ApiPropertyOptional({
    ...VEHICLE_CATEGORY_API_PROPERTY,
    nullable: true,
    description:
      'Categoría de la plataforma congelada al ingresar: si el dueño cambia ' +
      'la categoría del tipo, los ingresos ya hechos conservan la que ' +
      'guardaron. null en ingresos anteriores a las categorías o de cajas viejas.',
  })
  vehicleCategory: VehicleCategory | null;

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

  /** NULL = la tarifa vigente al ingresar no tenía escalón de media estadía. */
  @ApiPropertyOptional({ type: Number })
  rateSnapshotMediaEstadiaPriceArs: number | null;

  @ApiPropertyOptional({ format: 'uuid' })
  cashSessionId: string | null;

  @ApiPropertyOptional({ type: Number })
  ticketNumber: number | null;

  @ApiProperty({
    description:
      'Facturada por fuera de Parkit: el checkbox «Facturada» de las playas sin ARCA.',
  })
  manuallyInvoiced: boolean;

  @ApiProperty({ type: Number })
  version: number;

  @ApiProperty({ type: Number })
  syncSeq: number;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}
