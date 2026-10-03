import { ApiProperty } from '@nestjs/swagger';
import { ServiceCode } from '@prisma/client';

/**
 * Merged catalog view returned by `GET /tenants/:id/services`: every known
 * `ServiceCode` with its current enabled state (defaults to false when the
 * tenant has no stored row for that code yet) and, for ADVANCE_RESERVATION,
 * its configuration (null for other codes or when not configured).
 */
export class ServiceCatalogItemDto {
  @ApiProperty({ enum: ServiceCode })
  code: ServiceCode;

  @ApiProperty()
  enabled: boolean;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description:
      'Tarifa con la que se cotizan y cobran las reservas, sin distinción de vehículo (sólo ADVANCE_RESERVATION).',
  })
  reservationRateId: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Plazas que se pueden reservar a la vez (sólo ADVANCE_RESERVATION).',
  })
  reservableSpots: number | null;
}
