import { ApiProperty } from '@nestjs/swagger';
import type { BranchStatus } from '@prisma/client';
import { LPR_IMAGE_RETENTION_DAYS_OPTIONS } from './update-entity-profile.dto';

/**
 * Capacidad total del estacionamiento, en plazas. Vive en
 * `tenant.settings.capacity`.
 *
 * Antes eran tres contadores por tipo de vehículo, duplicados además en
 * `services.spots`. Las plazas no dependen de la carrocería: los tipos de
 * vehículo dicen QUÉ acepta la playa (`vehicle_types.accepted`), y esto dice
 * CUÁNTAS plazas tiene.
 */
export class EntityCapacityDto {
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Plazas totales del estacionamiento.',
    example: 110,
  })
  total: number;
}

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
    description: 'Display name of the payment method.',
    example: 'Efectivo',
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
      'Whether this is a built-in system method (`cash`, `transfer`). System methods can be enabled/disabled but never deleted.',
    example: true,
  })
  isSystem: boolean;

  @ApiProperty({
    type: Number,
    description: 'Monotonically-increasing sync sequence number.',
  })
  syncSeq: number;

  @ApiProperty({ type: Number, description: 'Optimistic-lock version.' })
  version: number;

  @ApiProperty({
    format: 'date-time',
    description: 'Last modification timestamp.',
  })
  updatedAt: string;

  @ApiProperty({ format: 'date-time', description: 'Creation timestamp.' })
  createdAt: string;
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
    type: EntityCapacityDto,
    description:
      'Per-vehicle-type spot capacity of the lot. Defaults to zeros when not configured.',
  })
  capacity: EntityCapacityDto;

  @ApiProperty({
    type: 'integer',
    enum: LPR_IMAGE_RETENTION_DAYS_OPTIONS,
    description:
      'Days a `registered` LPR detection image is kept after the stay exit before the retention job purges it. Owner-configurable, one of 30/60/90; defaults to 30. Readable by any member, editable only by an owner.',
    example: 30,
  })
  lprImageRetentionDays: number;

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
