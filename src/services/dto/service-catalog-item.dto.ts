import { ApiProperty } from '@nestjs/swagger';
import { ServiceCode } from '@prisma/client';
import { RESERVABLE_VEHICLE_CATEGORY_API_PROPERTY } from '../../vehicle-categories/dto/vehicle-category.dto';
import { RESERVATION_HOURS_MODES } from '../reservation-readiness';

const REQUIREMENTS = ['mp_account', 'spots', 'hours', 'vehicles', 'rate'];

export class ReservationReadinessDto {
  @ApiProperty({
    description:
      'Se cumplen todos los requisitos: se pueden activar las reservas.',
  })
  ready: boolean;

  @ApiProperty({
    enum: REQUIREMENTS,
    enumName: 'ReservationRequirement',
    isArray: true,
    description:
      'Requisitos que faltan, en el orden de la pantalla: mp_account (Mercado ' +
      'Pago vinculado), spots (plazas reservables), hours (horario), vehicles ' +
      '(al menos un tipo de vehículo) y rate (tarifa activa).',
  })
  missing: string[];
}

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

  @ApiProperty({
    ...RESERVABLE_VEHICLE_CATEGORY_API_PROPERTY,
    isArray: true,
    description:
      'Categorías de vehículo (las de `GET /vehicle-categories` con ' +
      '`reservable = true`) que pueden reservar desde la app ' +
      '(sólo ADVANCE_RESERVATION; vacío en otros códigos). Es independiente ' +
      'de qué tipos se aceptan en la caja (`vehicle_types.accepted`).',
  })
  reservationVehicleCategories: string[];

  @ApiProperty({
    enum: RESERVATION_HOURS_MODES,
    enumName: 'ReservationHoursMode',
    description:
      'opening = se reserva en el horario de apertura; custom = en los rangos ' +
      'de GET /services/ADVANCE_RESERVATION/hours.',
  })
  reservationHoursMode: string;

  @ApiProperty({
    enum: ['auto', 'manual'],
    enumName: 'ReservationAcceptanceMode',
    description: 'auto = se confirma sola; manual = la acepta el dueño.',
  })
  acceptanceMode: string;

  @ApiProperty({
    description: 'Minutos que tiene el dueño para responder en modo manual.',
    minimum: 5,
    maximum: 120,
  })
  approvalWindowMinutes: number;

  @ApiProperty({
    description: 'Cancelación gratis hasta estos minutos antes del ingreso.',
    minimum: 0,
    maximum: 1440,
  })
  freeCancelMinutes: number;

  @ApiProperty({
    description: '% que se reembolsa si el conductor cancela fuera de plazo.',
    minimum: 0,
    maximum: 100,
  })
  lateCancelRefundPct: number;

  @ApiProperty({
    description: 'Minutos antes del ingreso desde los que se puede llegar.',
    minimum: 0,
    maximum: 120,
  })
  earlyArrivalMinutes: number;

  @ApiProperty({
    description:
      'Tolerancia tras la hora de ingreso; pasada, la reserva es no-show.',
    minimum: 0,
    maximum: 180,
  })
  graceMinutes: number;

  @ApiProperty({
    type: ReservationReadinessDto,
    description: 'Requisitos para activar las reservas (ADVANCE_RESERVATION).',
  })
  readiness: ReservationReadinessDto;

  @ApiProperty({
    description:
      'Reservas confirmadas con ingreso futuro: siguen vigentes aunque se ' +
      'desactive el servicio.',
  })
  upcomingPaidReservations: number;
}
