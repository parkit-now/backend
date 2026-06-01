import { ApiProperty } from '@nestjs/swagger';
import type { BranchStatus, PaymentMethodType } from '@prisma/client';

/**
 * Summary of a tenant payment method exposed to the entity portal.
 */
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
    description: 'Whether the method is currently enabled for the entity.',
    example: true,
  })
  enabled: boolean;

  @ApiProperty({
    description: 'Whether this is the default payment method of the entity.',
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

/**
 * Public profile of an entity (tenant): the parking lot the caller is a member
 * of, with a summary of its configured payment methods.
 */
export class EntityProfileDto {
  @ApiProperty({
    description: 'Entity (tenant) id (UUID).',
    format: 'uuid',
    example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  })
  id: string;

  @ApiProperty({
    description: 'Display name of the entity (parking lot).',
    example: 'Estacionamiento del Centro',
  })
  name: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Registered legal name, or `null` if not provided.',
    example: 'Estacionamientos del Centro S.A.',
  })
  legalName: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'CUIT (Argentine tax id), or `null` if not provided.',
    example: '30123456789',
  })
  cuit: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Contact email, or `null` if not provided.',
    format: 'email',
    example: 'contacto@estacionamiento.com',
  })
  email: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Contact phone, or `null` if not provided.',
    example: '+541145678900',
  })
  phone: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Address, or `null` if not provided.',
    example: 'Av. Corrientes 1234, CABA',
  })
  address: string | null;

  @ApiProperty({
    enum: ['active', 'maintenance'],
    description: 'Operational status of the entity.',
    example: 'active',
  })
  status: BranchStatus;

  @ApiProperty({
    type: [PaymentMethodSummaryDto],
    description: 'Payment methods configured for this entity.',
  })
  paymentMethods: PaymentMethodSummaryDto[];

  @ApiProperty({
    description: 'ISO-8601 UTC timestamp of creation.',
    example: '2026-05-19T11:00:00.000Z',
  })
  createdAt: string;
}
