import { ApiProperty } from '@nestjs/swagger';
import { BranchStatus } from '@prisma/client';

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

  @ApiProperty({ nullable: true, description: 'Street address, if any.' })
  address: string | null;

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
}
