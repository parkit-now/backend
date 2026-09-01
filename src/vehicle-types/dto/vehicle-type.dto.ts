import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VehicleTypeDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty({ example: 'Utilitario', maxLength: 60 })
  name: string;

  @ApiProperty({
    description:
      'Si el estacionamiento acepta este tipo de vehículo. Reemplaza a los ' +
      'códigos `ServiceCode.VEHICLE_*`, que eran cinco valores fijos sin ' +
      'relación con el catálogo.',
  })
  accepted: boolean;

  @ApiProperty({
    type: Number,
    description:
      'Versión de la fila, para optimistic locking. Reenviala como ' +
      '`?expectedVersion=N` en PATCH y DELETE.',
  })
  version: number;

  @ApiProperty({ type: Number })
  syncSeq: number;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    description:
      'No-nulo cuando el tipo fue borrado lógicamente. Las filas con valor ' +
      'no-nulo solo aparecen en GET /vehicle-types/changes, como tombstone ' +
      'del sync.',
  })
  deletedAt: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}

/**
 * Lo que devuelve el listado del ABM.
 *
 * `vehicleCount` NO va en el feed de sync: es un derivado que envejece, y el
 * desktop hace `bulkPut` de lo que recibe. Acá sirve para que el modal de
 * borrado sepa de antemano si tiene que pedir un tipo destino. Es una foto: la
 * verdad la impone el 409 `VEHICLE_TYPE_IN_USE`.
 */
export class VehicleTypeListItemDto extends VehicleTypeDto {
  @ApiProperty({
    type: Number,
    description: 'Vehículos vivos que usan este tipo.',
  })
  vehicleCount: number;
}
