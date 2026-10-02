import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { BranchStatus } from '@prisma/client';
import { UpdateEntityAddressDto } from './entity-address.dto';

export const TICKET_TEMPLATE_FIELD_IDS = [
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
] as const;

/**
 * Allowed values for `lprImageRetentionDays`. A closed set instead of a free
 * 30-365 range on purpose: privacy-by-design calls for a short, defensible
 * default plus a handful of vetted options, not a knob any owner can push to
 * the ceiling with no documented reason. A per-event legal-hold exception
 * (for a specific plate under dispute) is a separate, not-yet-built
 * mechanism — it should never be "raise the whole tenant's window".
 */
export const LPR_IMAGE_RETENTION_DAYS_OPTIONS = [30, 60, 90] as const;

/** Editable per-vehicle-type spot capacity of the lot (stored in settings). */
export class UpdateEntityCapacityDto {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    description: 'Plazas totales del estacionamiento.',
    example: 110,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  total?: number;
}

export class UpdateTicketTemplateFieldDto {
  @ApiPropertyOptional({
    enum: TICKET_TEMPLATE_FIELD_IDS,
    description: 'Stable ticket field identifier.',
    example: 'plate',
  })
  @IsIn(TICKET_TEMPLATE_FIELD_IDS)
  id: string;

  @ApiPropertyOptional({
    description: 'Whether the field is printed.',
    example: true,
  })
  @IsBoolean()
  visible: boolean;

  @ApiPropertyOptional({
    description: 'Font size in points.',
    minimum: 6,
    maximum: 32,
    example: 13,
  })
  @IsNumber()
  @Min(6)
  @Max(32)
  fontSizePt: number;

  @ApiPropertyOptional({
    enum: ['normal', 'bold'],
    description: 'Text emphasis.',
    example: 'bold',
  })
  @IsIn(['normal', 'bold'])
  emphasis: 'normal' | 'bold';
}

export class UpdateTicketTemplateDto {
  @ApiPropertyOptional({
    type: 'integer',
    enum: [1],
    description: 'Template schema version.',
    example: 1,
  })
  @IsIn([1])
  version: 1;

  @ApiPropertyOptional({
    type: [UpdateTicketTemplateFieldDto],
    description: 'Ordered ticket fields.',
  })
  @IsArray()
  @ArrayMaxSize(TICKET_TEMPLATE_FIELD_IDS.length)
  @ValidateNested({ each: true })
  @Type(() => UpdateTicketTemplateFieldDto)
  fields: UpdateTicketTemplateFieldDto[];

  @ApiPropertyOptional({
    description: 'Optional CUIT override printed on the ticket.',
    maxLength: 80,
  })
  @IsString()
  @MaxLength(80)
  cuitOverride: string;

  @ApiPropertyOptional({
    description: 'Gross income registration text printed on the ticket.',
    maxLength: 120,
  })
  @IsString()
  @MaxLength(120)
  grossIncomeText: string;

  @ApiPropertyOptional({
    description: 'Non-fiscal control legend printed on the ticket.',
    maxLength: 120,
  })
  @IsString()
  @MaxLength(120)
  nonFiscalControlText: string;
}

export class UpdateDesktopCameraConfigDto {
  @ApiPropertyOptional({
    enum: ['webcam', 'ip'],
    description: 'Video source mode.',
    example: 'ip',
  })
  @IsIn(['webcam', 'ip'])
  mode: 'webcam' | 'ip';

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    description: 'OpenCV webcam index.',
    example: 0,
  })
  @IsInt()
  @Min(0)
  deviceIndex: number;

  @ApiPropertyOptional({
    description: 'IP camera host. Empty for webcam mode.',
    maxLength: 160,
    example: '192.168.1.26',
  })
  @IsString()
  @MaxLength(160)
  host: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 65535,
    description: 'IP camera RTSP port.',
    example: 554,
  })
  @IsInt()
  @Min(1)
  @Max(65535)
  port: number;

  @ApiPropertyOptional({
    description: 'IP camera username. Password is intentionally not persisted.',
    maxLength: 120,
  })
  @IsString()
  @MaxLength(120)
  username: string;

  @ApiPropertyOptional({
    description: 'IP camera stream path.',
    maxLength: 220,
    example: '/h264_stream',
  })
  @IsString()
  @MaxLength(220)
  streamPath: string;

  @ApiPropertyOptional({
    description: 'Stable camera identifier sent with LPR detections.',
    maxLength: 100,
  })
  @IsString()
  @MaxLength(100)
  cameraId: string;

  @ApiPropertyOptional({
    enum: ['entrada', 'salida'],
    description: 'Camera location.',
    example: 'entrada',
  })
  @IsIn(['entrada', 'salida'])
  location: 'entrada' | 'salida';

  @ApiPropertyOptional({
    type: Object,
    nullable: true,
    description:
      'Camera detection tuning, including ROI. Passwords are never stored here.',
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsObject()
  tuning?: Record<string, unknown> | null;
}

/** Editable fields of an entity (tenant) profile. */
export class UpdateEntityProfileDto {
  @ApiPropertyOptional({
    description: 'New display name of the entity.',
    example: 'Estacionamiento del Centro',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: 'New legal name of the entity.',
    example: 'Estacionamientos del Centro S.A.',
  })
  @IsOptional()
  @IsString()
  legalName?: string;

  @ApiPropertyOptional({
    description: 'New CUIT (Argentine tax id), 11 digits.',
    example: '30123456789',
  })
  @IsOptional()
  @Matches(/^\d{11}$/, { message: 'CUIT must have 11 digits' })
  cuit?: string;

  @ApiPropertyOptional({
    format: 'email',
    description: 'New contact email of the entity.',
    example: 'contact@parkit.com',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    description:
      'New contact phone number of the entity, in international E.164 format (`+5491123456789`). The format is only enforced when the value CHANGES: legacy profiles keep their stored free-text phone, and sending it back unchanged is accepted.',
    example: '+5491155551234',
  })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({
    description:
      'Nueva dirección en una línea (campo de display, legacy). Si también se manda `location.formatted`, gana ese.',
    example: 'Av. Corrientes 1000, Buenos Aires',
  })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({
    type: UpdateEntityAddressDto,
    description:
      'Dirección estructurada. Sólo se actualizan los campos presentes; mandar `null` explícito borra ese campo. Las coordenadas van completas (lat + lng) o ninguna: la base rechaza media coordenada.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateEntityAddressDto)
  location?: UpdateEntityAddressDto;

  @ApiPropertyOptional({
    enum: ['active', 'maintenance'],
    description:
      'New operational status. Use `maintenance` to take the lot offline.',
    example: 'active',
  })
  @IsOptional()
  @IsIn(['active', 'maintenance'])
  status?: BranchStatus;

  @ApiPropertyOptional({
    type: UpdateEntityCapacityDto,
    description:
      'New per-vehicle-type spot capacity. Only the provided types are updated; the rest keep their current value.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateEntityCapacityDto)
  capacity?: UpdateEntityCapacityDto;

  @ApiPropertyOptional({
    type: UpdateTicketTemplateDto,
    description:
      'Ticket template owned by this entity. Owner-only; local printer/device settings remain client-side.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateTicketTemplateDto)
  ticketTemplate?: UpdateTicketTemplateDto;

  @ApiPropertyOptional({
    type: UpdateDesktopCameraConfigDto,
    description:
      'Desktop camera configuration owned by this entity, excluding the password.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateDesktopCameraConfigDto)
  desktopCameraConfig?: UpdateDesktopCameraConfigDto;

  @ApiPropertyOptional({
    type: 'integer',
    enum: LPR_IMAGE_RETENTION_DAYS_OPTIONS,
    description:
      'How long (in days) a `registered` LPR detection image is kept after the stay exit before the retention job purges it. One of 30/60/90. Owner-only.',
    example: 30,
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(LPR_IMAGE_RETENTION_DAYS_OPTIONS)
  lprImageRetentionDays?: number;

  @ApiPropertyOptional({
    description:
      "Stable identifier of this parking lot's entrance camera. The desktop app sends it as CAMERA_ID and it ends up in every LPR detection. Send null to unlink. Owner-only.",
    example: 'cam-entrada',
    maxLength: 100,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(100)
  entryCameraId?: string | null;

  @ApiPropertyOptional({
    description:
      'Human-readable name of the entrance camera, so the owner can tell it apart. Owner-only.',
    example: 'Portón Rivadavia',
    maxLength: 120,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(120)
  entryCameraLabel?: string | null;
}
