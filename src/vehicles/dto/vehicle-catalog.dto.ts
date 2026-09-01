import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VehicleBodyType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class VehicleCatalogItemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Toyota' })
  brand: string;

  @ApiProperty({ example: 'Corolla' })
  model: string;

  @ApiPropertyOptional({
    enum: VehicleBodyType,
    nullable: true,
    example: VehicleBodyType.auto,
  })
  type: VehicleBodyType | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'null = global (admin-managed, read-only para los estacionamientos), ' +
      'UUID = propio de ese estacionamiento.',
  })
  tenantId: string | null;

  @ApiProperty({
    type: Number,
    description:
      'Versión de la fila, para optimistic locking. Reenviala como ' +
      '`?expectedVersion=N` en PATCH y DELETE. La bumpea el trigger ' +
      '`set_vehicles_sync_fields` en cada UPDATE.',
  })
  version: number;

  @ApiProperty({ type: Number })
  syncSeq: number;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    description:
      'No-nulo cuando el vehículo fue borrado lógicamente. Las filas con valor ' +
      'no-nulo solo aparecen en GET /vehicles/catalog, como tombstone del sync.',
  })
  deletedAt: string | null;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class VehicleCatalogChangesResponseDto {
  @ApiProperty({ type: [VehicleCatalogItemDto] })
  items: VehicleCatalogItemDto[];

  @ApiProperty({ type: Number })
  maxSeq: number;
}

export class VehicleCatalogChangesQueryDto {
  @ApiPropertyOptional({
    description: 'Devuelve las filas con syncSeq mayor a este valor.',
    default: 0,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterSeq = 0;

  @ApiPropertyOptional({
    description: 'Máximo de items por página.',
    default: 1000,
    minimum: 1,
    maximum: 1000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit = 1000;
}
