import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ReservationStatus } from '@prisma/client';
import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { normalizePlate } from '../driver-rules';
import { VEHICLE_CATEGORY_API_PROPERTY } from '../../vehicle-categories/dto/vehicle-category.dto';
import { type VehicleCategory } from '../../vehicle-categories/vehicle-categories';

export class CreateReservationDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Lo genera el cliente: es la clave de idempotencia. Reintentar con el ' +
      'mismo id devuelve la reserva ya creada.',
  })
  @IsUUID()
  id: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  parkingId: string;

  @ApiProperty({
    example: 'AB123CD',
    description: 'Se normaliza (mayúsculas, sin espacios ni guiones).',
  })
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizePlate(value) : value,
  )
  @Matches(/^[A-Z0-9]{3,10}$/)
  vehiclePlate: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-30T10:00:00-03:00' })
  @IsDateString()
  entryAt: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-30T13:00:00-03:00' })
  @IsDateString()
  exitAt: string;

  @ApiProperty({
    required: false,
    description:
      'A dónde vuelve el conductor después de pagar. Con él la reserva nace ' +
      'en pending_payment y la respuesta trae el checkout. Sin él: en ' +
      'producción 422 RESERVATION_CLIENT_OUTDATED; fuera de producción se ' +
      'mantiene el camino viejo (confirmada, sin pago, respuesta plana).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  returnUrl?: string;
}

export enum DriverReservationStateDto {
  active = 'active',
  completed = 'completed',
  cancelled = 'cancelled',
}

export class DriverReservationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'Código corto para mostrar (R-XXXXXX).' })
  code: string;

  @ApiProperty({
    enum: DriverReservationStateDto,
    enumName: 'DriverReservationState',
  })
  state: DriverReservationStateDto;

  @ApiProperty({ description: 'Se puede cancelar (activa y sin empezar).' })
  cancellable: boolean;

  @ApiProperty({ format: 'uuid' })
  parkingId: string;

  @ApiProperty()
  parkingName: string;

  @ApiProperty({ type: String, nullable: true })
  parkingAddress: string | null;

  @ApiProperty({ type: Number, nullable: true })
  latitude: number | null;

  @ApiProperty({ type: Number, nullable: true })
  longitude: number | null;

  @ApiProperty()
  vehiclePlate: string;

  @ApiProperty({
    ...VEHICLE_CATEGORY_API_PROPERTY,
    nullable: true,
    description:
      'Categoría del vehículo del conductor al reservar (snapshot). null en las reservas anteriores a las categorías.',
  })
  vehicleCategory: VehicleCategory | null;

  @ApiProperty({ format: 'date-time' })
  entryAt: string;

  @ApiProperty({ format: 'date-time' })
  exitAt: string;

  @ApiProperty({ type: Number })
  totalArs: number;

  @ApiProperty()
  rateName: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class ReservationPolicyDto {
  @ApiProperty({
    description: 'Minutos antes del ingreso con reembolso total.',
  })
  freeCancelMinutes: number;

  @ApiProperty({ description: '% que se reembolsa pasado el corte gratis.' })
  lateCancelRefundPct: number;

  @ApiProperty()
  earlyArrivalMinutes: number;

  @ApiProperty({ description: 'Tolerancia después de la hora de ingreso.' })
  graceMinutes: number;

  @ApiProperty({ enum: ['auto', 'manual'] })
  acceptanceMode: 'auto' | 'manual';

  @ApiProperty({ description: 'Minutos que tiene el dueño para aceptar.' })
  approvalWindowMinutes: number;
}

export class ReservationPaymentSummaryDto {
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

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Sólo mientras el pago está pendiente de hacerse.',
  })
  checkoutUrl: string | null;
}

/** Reserva del conductor con el ciclo de vida completo. */
export class DriverReservationDetailDto extends DriverReservationDto {
  @ApiProperty({ enum: ReservationStatus, enumName: 'ReservationStatus' })
  status: ReservationStatus;

  @ApiProperty({
    enum: ['none', 'pending', 'refunded', 'partial', 'failed'],
  })
  refundStatus: string;

  @ApiProperty({ type: Number, nullable: true })
  refundedAmountArs: number | null;

  @ApiProperty({ type: ReservationPolicyDto })
  policy: ReservationPolicyDto;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Hasta cuándo se puede pagar (pending_payment).',
  })
  holdExpiresAt: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Hasta cuándo puede responder el dueño (pending_approval).',
  })
  approvalDeadlineAt: string | null;

  @ApiProperty({ type: ReservationPaymentSummaryDto, nullable: true })
  payment: ReservationPaymentSummaryDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['driver', 'owner', 'system'],
    description: 'Quién canceló o rechazó la reserva.',
  })
  cancelledBy: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Motivo de la cancelación o el rechazo: texto libre del dueño, o un ' +
      'código del sistema (approval_timeout, late_payment_no_capacity, ' +
      'checkout_unavailable).',
  })
  reason: string | null;
}

export class ReservationCheckoutDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Donde paga el conductor; null si ya no hay nada que pagar.',
  })
  checkoutUrl: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  holdExpiresAt: string | null;
}

export class CreateReservationResponseDto {
  @ApiProperty({ type: DriverReservationDetailDto })
  reservation: DriverReservationDetailDto;

  @ApiProperty({ type: ReservationCheckoutDto })
  payment: ReservationCheckoutDto;
}

export class CancelPreviewDto {
  @ApiProperty()
  allowed: boolean;

  @ApiProperty({ description: 'Lo que se reembolsaría, en pesos.' })
  refundArs: number;

  @ApiProperty({ enum: ['full', 'partial', 'none'] })
  kind: 'full' | 'partial' | 'none';

  @ApiProperty({
    enum: [
      'free_window',
      'late_window',
      'pending_approval',
      'not_paid',
      'owner',
      'already_started',
      'not_cancellable',
    ],
  })
  reasonCode: string;
}
