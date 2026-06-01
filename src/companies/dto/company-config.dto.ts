import { ApiProperty } from '@nestjs/swagger';
import type { BranchStatus, PaymentMethodType } from '@prisma/client';

/**
 * Branch (tenant) with spot counts aggregated from its zones.
 * `occupancyPct` and `managerName` are operational → out of scope (0 / '').
 */
export class BranchDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Branch (tenant) identifier.',
    example: '8f2b1c4e-3d2a-4f1b-9c0e-1a2b3c4d5e6f',
  })
  id: string;

  @ApiProperty({
    description: 'Display name of the branch (parking lot).',
    example: 'Palermo Lot',
  })
  name: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Street address of the branch, or null when not set.',
    example: 'Av. Santa Fe 1234, Buenos Aires',
  })
  address: string | null;

  @ApiProperty({
    enum: ['active', 'maintenance'],
    description: 'Operational status of the branch.',
    example: 'active',
  })
  status: BranchStatus;

  @ApiProperty({
    type: 'integer',
    description:
      'Total parking spots, aggregated across all zones (car + motorcycle + bicycle).',
    example: 120,
  })
  totalSpots: number;

  @ApiProperty({
    type: 'integer',
    description: 'Car spots aggregated from the zones of the branch.',
    example: 90,
  })
  carSpots: number;

  @ApiProperty({
    type: 'integer',
    description: 'Motorcycle spots aggregated from the zones of the branch.',
    example: 20,
  })
  motorcycleSpots: number;

  @ApiProperty({
    type: 'integer',
    description: 'Bicycle spots aggregated from the zones of the branch.',
    example: 10,
  })
  bicycleSpots: number;

  @ApiProperty({
    type: 'integer',
    description:
      'Operational metric (out of scope): always 0 in configuration.',
    example: 0,
  })
  occupancyPct: number;

  @ApiProperty({
    description:
      'Operational metric (out of scope): always empty in configuration.',
    example: '',
  })
  managerName: string;
}

export class PaymentMethodSummaryDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Payment method identifier.',
    example: '2a1b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d',
  })
  id: string;

  @ApiProperty({
    enum: ['mp_transfer', 'cash', 'other'],
    description:
      'Payment method type. `mp_transfer` and `cash` are system methods; `other` is custom.',
    example: 'cash',
  })
  type: PaymentMethodType;

  @ApiProperty({
    description: 'Display name of the payment method.',
    example: 'Cash',
  })
  name: string;

  @ApiProperty({
    description: 'Whether the method is currently enabled for the company.',
    example: true,
  })
  enabled: boolean;

  @ApiProperty({
    description: 'Whether this is the default payment method of the company.',
    example: false,
  })
  isDefault: boolean;

  @ApiProperty({
    description:
      'Whether this is a system method (`mp_transfer` / `cash`). System methods can be disabled but never deleted.',
    example: true,
  })
  isSystem: boolean;
}
