import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethodType } from '@prisma/client';
import type { BranchStatus } from '@prisma/client';
import { EntityAddressDto } from './entity-address.dto';
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

export class TicketTemplateFieldDto {
  @ApiProperty({
    description: 'Stable ticket field identifier.',
    enum: [
      'parkingName',
      'parkingAddress',
      'parkingCuit',
      'grossIncome',
      'nonFiscalControl',
      'ticketNumber',
      'plate',
      'vehicleBrand',
      'vehicleModel',
      'color',
      'rate',
      'entryDate',
      'entryTime',
      'cochera',
      'notes',
    ],
    example: 'plate',
  })
  id: string;

  @ApiProperty({
    description: 'Whether the field is printed.',
    example: true,
  })
  visible: boolean;

  @ApiProperty({
    description: 'Font size in points.',
    minimum: 6,
    maximum: 32,
    example: 13,
  })
  fontSizePt: number;

  @ApiProperty({
    description: 'Text emphasis.',
    enum: ['normal', 'bold'],
    example: 'bold',
  })
  emphasis: 'normal' | 'bold';
}

export class TicketTemplateDto {
  @ApiProperty({
    type: 'integer',
    enum: [1],
    description: 'Template schema version.',
    example: 1,
  })
  version: 1;

  @ApiProperty({
    type: [TicketTemplateFieldDto],
    description: 'Ordered ticket fields.',
  })
  fields: TicketTemplateFieldDto[];

  @ApiProperty({
    description: 'Optional CUIT override printed on the ticket.',
    example: '30-12345678-9',
  })
  cuitOverride: string;

  @ApiProperty({
    description: 'Gross income registration text printed on the ticket.',
    example: 'IIBB: 1027025-06',
  })
  grossIncomeText: string;

  @ApiProperty({
    description: 'Non-fiscal control legend printed on the ticket.',
    example: 'Control no fiscal',
  })
  nonFiscalControlText: string;
}

export class DesktopCameraConfigDto {
  @ApiProperty({
    enum: ['webcam', 'ip'],
    description: 'Video source mode.',
    example: 'ip',
  })
  mode: 'webcam' | 'ip';

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'OpenCV webcam index.',
    example: 0,
  })
  deviceIndex: number;

  @ApiProperty({
    description: 'IP camera host. Empty for webcam mode.',
    example: '192.168.1.26',
  })
  host: string;

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: 65535,
    description: 'IP camera RTSP port.',
    example: 554,
  })
  port: number;

  @ApiProperty({
    description: 'IP camera username. Password is intentionally not persisted.',
    example: 'admin',
  })
  username: string;

  @ApiProperty({
    description: 'IP camera stream path.',
    example: '/h264_stream',
  })
  streamPath: string;

  @ApiProperty({
    description: 'Stable camera identifier sent with LPR detections.',
    example: 'entrada-rivadavia',
  })
  cameraId: string;

  @ApiProperty({
    enum: ['entrada', 'salida'],
    description: 'Camera location.',
    example: 'entrada',
  })
  location: 'entrada' | 'salida';

  @ApiProperty({
    type: Object,
    nullable: true,
    description:
      'Camera detection tuning, including ROI. Passwords are never stored here.',
  })
  tuning: Record<string, unknown> | null;
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

  /**
   * Lo que el medio ES, contra `name`, que es cómo el dueño decidió llamarlo.
   *
   * Sin este campo el desktop no puede snapshotear el tipo al cobrar y el
   * arqueo de caja no tiene más remedio que adivinar buscando "efectivo" en el
   * nombre — que es exactamente el bug que rompía el arqueo de cualquiera que
   * renombrara su método a "Caja".
   */
  @ApiProperty({
    description:
      'What the method IS, as opposed to `name` (what the owner calls it). The desktop snapshots this on every charge so the cash count never has to guess from the name.',
    enum: PaymentMethodType,
    enumName: 'PaymentMethodType',
    example: PaymentMethodType.cash,
  })
  type: PaymentMethodType;

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
      'Whether this is a built-in system method — `cash` and `transfer` (seeded with the entity), plus `mercadopago_qr` (created when the Mercado Pago account is linked). System methods can be renamed and enabled/disabled, but never deleted. Enabling an integration-backed one (`mercadopago_qr`) requires its account to be linked.',
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
    description:
      'Dirección en una línea, para mostrar. Se conserva por retrocompatibilidad y es el mismo valor que `location.formatted`. Los campos separados que necesita Mercado Pago están en `location`.',
    example: 'Av. Corrientes 1234, CABA',
  })
  address: string | null;

  @ApiProperty({
    type: EntityAddressDto,
    description:
      'Dirección estructurada (calle, altura, localidad, provincia, coordenadas). Campos separados porque Mercado Pago los necesita así para dar de alta el `Store` del cobro con QR. Todos pueden venir en `null`: las filas anteriores a la migración 20260913164617 no tienen los campos cargados y no se hizo backfill.',
  })
  location: EntityAddressDto;

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
    type: TicketTemplateDto,
    nullable: true,
    description:
      'Ticket template owned by the entity. Null means clients should use their built-in default or a local fallback.',
  })
  ticketTemplate: TicketTemplateDto | null;

  @ApiProperty({
    type: DesktopCameraConfigDto,
    nullable: true,
    description:
      'Desktop camera configuration owned by the entity, excluding the camera password.',
  })
  desktopCameraConfig: DesktopCameraConfigDto | null;

  @ApiProperty({
    type: 'integer',
    enum: LPR_IMAGE_RETENTION_DAYS_OPTIONS,
    description:
      'Days a `registered` LPR detection image is kept after the stay exit before the retention job purges it. Owner-configurable, one of 30/60/90; defaults to 30. Readable by any member, editable only by an owner.',
    example: 30,
  })
  lprImageRetentionDays: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "Stable identifier of this parking lot's entrance camera, or null when none is configured. It is what every LPR detection of this lot carries as `cameraId`.",
    example: 'cam-entrada',
  })
  entryCameraId: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Human-readable name of the entrance camera, or null.',
    example: 'Portón Rivadavia',
  })
  entryCameraLabel: string | null;

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
