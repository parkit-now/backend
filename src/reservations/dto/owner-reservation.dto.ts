import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReservationStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../utils/pagination/pagination-query.dto';
import { VEHICLE_CATEGORY_API_PROPERTY } from '../../vehicle-categories/dto/vehicle-category.dto';
import { type VehicleCategory } from '../../vehicle-categories/vehicle-categories';

const REFUND_STATUSES = ['none', 'pending', 'refunded', 'partial', 'failed'];

/** Filtros del listado de reservas del dueño. */
export class ListOwnerReservationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ReservationStatus,
    enumName: 'ReservationStatus',
  })
  @IsOptional()
  @IsEnum(ReservationStatus)
  status?: ReservationStatus;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Reservas cuyo ingreso es desde esta fecha (inclusive).',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Reservas cuyo ingreso es hasta esta fecha (inclusive).',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({
    description: 'Busca por patente (contiene, sin distinguir formato).',
    example: 'AB12',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(20)
  q?: string;
}

/** Motivo obligatorio al rechazar o cancelar. */
export class ReservationReasonDto {
  @ApiProperty({
    maxLength: 500,
    description: 'Motivo; lo ve el conductor.',
    example: 'La playa cierra por mantenimiento.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class OwnerReservationPolicyDto {
  @ApiProperty()
  freeCancelMinutes: number;

  @ApiProperty()
  lateCancelRefundPct: number;

  @ApiProperty()
  earlyArrivalMinutes: number;

  @ApiProperty()
  graceMinutes: number;

  @ApiProperty({ enum: ['auto', 'manual'] })
  acceptanceMode: 'auto' | 'manual';

  @ApiProperty()
  approvalWindowMinutes: number;

  @ApiProperty({
    description:
      'Tope de la llegada anticipada al reservar: hasta cuántos minutos antes ' +
      'de la hora de ingreso el auto se vincula ("llegó antes"). Las reservas ' +
      'anteriores al tope muestran el default (60).',
  })
  earlyArrivalMaxMinutes: number;
}

export class OwnerReservationPaymentDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    enum: [
      'created',
      'approved',
      'rejected',
      'cancelled',
      'refunded',
      'partially_refunded',
    ],
  })
  status: string;

  @ApiProperty()
  amountArs: number;

  @ApiProperty()
  provider: string;

  @ApiProperty({ type: String, nullable: true })
  providerPaymentId: string | null;

  @ApiProperty({ type: String, nullable: true })
  providerStatus: string | null;

  @ApiProperty({ type: String, nullable: true })
  providerStatusDetail: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  approvedAt: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

/** El ingreso de la caja vinculado a la reserva (fase 6). */
export class OwnerReservationStayDto {
  @ApiProperty({ format: 'uuid' })
  entryId: string;

  @ApiProperty({ format: 'date-time', description: 'Cuándo entró el auto.' })
  enteredAt: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo salió; null mientras sigue adentro.',
  })
  leftAt: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Lo cobrado en la caja al salir: el excedente sobre el prepago. null ' +
      'mientras sigue adentro.',
  })
  excessChargedArs: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Prepago descontado en la caja (snapshot del ingreso).',
  })
  prepaidAmountArs: number | null;
}

export class OwnerReservationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'Código corto (R-XXXXXX).' })
  code: string;

  @ApiProperty({ enum: ReservationStatus, enumName: 'ReservationStatus' })
  status: ReservationStatus;

  @ApiProperty()
  vehiclePlate: string;

  @ApiProperty({
    ...VEHICLE_CATEGORY_API_PROPERTY,
    nullable: true,
    description:
      'Categoría del vehículo del conductor al reservar (snapshot). null en las reservas anteriores a las categorías.',
  })
  vehicleCategory: VehicleCategory | null;

  @ApiProperty({ type: String, nullable: true })
  driverName: string | null;

  @ApiProperty({ format: 'date-time' })
  entryAt: string;

  @ApiProperty({ format: 'date-time' })
  exitAt: string;

  @ApiProperty()
  totalArs: number;

  @ApiProperty()
  rateName: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  holdExpiresAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paidAt: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Hasta cuándo puede aceptar o rechazar el dueño.',
  })
  approvalDeadlineAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: string | null;

  @ApiProperty({
    type: String,
    enum: ['driver', 'owner', 'system'],
    nullable: true,
  })
  cancelledBy: string | null;

  @ApiProperty({ type: String, nullable: true })
  reason: string | null;

  @ApiProperty({ enum: REFUND_STATUSES })
  refundStatus: string;

  @ApiProperty({ type: Number, nullable: true })
  refundedAmountArs: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Por qué falló el reembolso (refundStatus = failed).',
  })
  refundError: string | null;

  @ApiProperty({ type: OwnerReservationPolicyDto })
  policy: OwnerReservationPolicyDto;

  @ApiProperty({
    type: OwnerReservationStayDto,
    nullable: true,
    description:
      'Ingreso de la caja vinculado (checked_in / completed). null si el auto ' +
      'todavía no entró o la reserva no llegó a usarse.',
  })
  stay: OwnerReservationStayDto | null;
}

export class OwnerReservationDetailDto extends OwnerReservationDto {
  @ApiProperty()
  refundAttempts: number;

  @ApiProperty({ type: Number, nullable: true })
  refundRequestedArs: number | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  refundRequestedAt: string | null;

  @ApiProperty({
    type: [OwnerReservationPaymentDto],
    description: 'Intentos de cobro, el más nuevo primero.',
  })
  payments: OwnerReservationPaymentDto[];
}

export class PaginatedOwnerReservationsDto {
  @ApiProperty({ type: [OwnerReservationDto] })
  items: OwnerReservationDto[];

  @ApiProperty({ type: 'integer' })
  total: number;

  @ApiProperty({ type: 'integer', example: 1 })
  page: number;

  @ApiProperty({ type: 'integer', example: 20 })
  pageSize: number;
}

/** `GET /reservations/match?plate=`: la patente que tipea la caja. */
export class ReservationMatchQueryDto {
  @ApiProperty({
    description: 'Patente tal como la tipea el operador; se normaliza.',
    example: 'AB 123 CD',
    maxLength: 20,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  plate: string;
}

/** La reserva que el banner de la caja muestra al cargar la patente. */
export class ReservationMatchDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'Código corto (R-XXXXXX).' })
  code: string;

  @ApiProperty({ enum: ReservationStatus, enumName: 'ReservationStatus' })
  status: ReservationStatus;

  @ApiProperty()
  vehiclePlate: string;

  @ApiProperty({ ...VEHICLE_CATEGORY_API_PROPERTY, nullable: true })
  vehicleCategory: VehicleCategory | null;

  @ApiProperty({ type: String, nullable: true })
  driverName: string | null;

  @ApiProperty({ format: 'date-time' })
  entryAt: string;

  @ApiProperty({ format: 'date-time' })
  exitAt: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Desde cuándo puede entrar (entryAt − llegada anticipada).',
  })
  arrivalFrom: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Hasta cuándo puede entrar (entryAt + tolerancia).',
  })
  arrivalUntil: string;

  @ApiProperty({ description: 'Precio total de la reserva.' })
  totalArs: number;

  @ApiProperty({
    description:
      'Lo que el conductor ya pagó por Mercado Pago; la caja lo descuenta. 0 ' +
      'si no hay pago registrado (camino viejo, sólo fuera de producción).',
  })
  prepaidAmountArs: number;
}

export class ReservationMatchResponseDto {
  @ApiProperty({
    type: ReservationMatchDto,
    nullable: true,
    description:
      'La reserva confirmada de esa patente dentro de su ventana de llegada, ' +
      'o null.',
  })
  reservation: ReservationMatchDto | null;
}
