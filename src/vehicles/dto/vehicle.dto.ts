import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class VehicleDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Toyota' })
  brand: string;

  @ApiProperty({ example: 'Corolla' })
  model: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Tipo de vehículo, de la tabla `vehicle_types` de este estacionamiento. ' +
      'Obligatorio: borrar un tipo obliga a reasignar, así que un vehículo ' +
      'nunca queda sin tipo.',
  })
  typeId: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

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
      'no-nulo solo aparecen en GET /vehicles/changes, como tombstone del sync.',
  })
  deletedAt: string | null;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class VehicleChangesResponseDto {
  @ApiProperty({ type: [VehicleDto] })
  items: VehicleDto[];

  @ApiProperty({ type: Number })
  maxSeq: number;
}

export class VehicleChangesQueryDto {
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
