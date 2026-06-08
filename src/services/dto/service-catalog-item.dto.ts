import { ApiProperty } from '@nestjs/swagger';
import { ServiceCode } from '@prisma/client';

/**
 * Merged catalog view returned by `GET /tenants/:id/services`: every known
 * `ServiceCode` with its current enabled state (defaults to false when the
 * tenant has no stored row for that code yet).
 */
export class ServiceCatalogItemDto {
  @ApiProperty({ enum: ServiceCode })
  code: ServiceCode;

  @ApiProperty()
  enabled: boolean;

  @ApiProperty({
    type: Number,
    description:
      'Spots assigned to this vehicle type (0 for non-vehicle codes).',
  })
  spots: number;
}
