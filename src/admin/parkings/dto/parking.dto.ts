import { ApiProperty } from '@nestjs/swagger';
import { BranchStatus } from '@prisma/client';
import { EntityAddressDto } from '../../../entities/dto/entity-address.dto';

/**
 * Public representation of a parking lot (the `Tenant` model) as exposed by the
 * admin panel. Internal-only columns (`settings`) are intentionally omitted.
 *
 * Every field is explicitly decorated: the `@nestjs/swagger` CLI plugin is not
 * enabled, so undecorated properties would be absent from the OpenAPI contract
 * the frontend types are generated from.
 */
export class ParkingDto {
  @ApiProperty({ format: 'uuid', description: 'Parking lot id (uuid).' })
  id: string;

  @ApiProperty({ description: 'Display name of the parking lot.' })
  name: string;

  @ApiProperty({
    nullable: true,
    description: 'Registered legal/company name, if any.',
  })
  legalName: string | null;

  @ApiProperty({ nullable: true, description: 'Tax id (CUIT), if any.' })
  cuit: string | null;

  @ApiProperty({ nullable: true, description: 'Contact email, if any.' })
  email: string | null;

  @ApiProperty({ nullable: true, description: 'Contact phone, if any.' })
  phone: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Dirección en una línea, para mostrar. Mismo valor que `location.formatted`; se conserva por retrocompatibilidad.',
  })
  address: string | null;

  @ApiProperty({
    type: EntityAddressDto,
    description:
      'Dirección estructurada (calle, altura, localidad, provincia, coordenadas). Campos en `null` cuando el estacionamiento es anterior a la migración 20260913164617: no hubo backfill.',
  })
  location: EntityAddressDto;

  @ApiProperty({
    enum: BranchStatus,
    description: 'Operational status: `active` or `maintenance`.',
  })
  status: BranchStatus;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    description: 'Creation timestamp.',
  })
  createdAt: Date;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    nullable: true,
    description:
      'Cuándo se dio de baja. `null` = vivo. Sólo lo ve el admin global: para ' +
      'el resto del producto un estacionamiento con esto seteado no existe.',
  })
  deletedAt: Date | null;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    nullable: true,
    description:
      'Desde cuándo la purga puede borrarlo definitivamente. Hasta ese momento ' +
      'se puede restaurar; después no queda nada que restaurar.',
  })
  purgeAfter: Date | null;
}
