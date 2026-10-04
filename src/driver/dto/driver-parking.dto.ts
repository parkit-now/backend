import { ApiProperty } from '@nestjs/swagger';
import { ScheduleDay } from '@prisma/client';
import { RESERVABLE_VEHICLE_CATEGORY_API_PROPERTY } from '../../vehicle-categories/dto/vehicle-category.dto';

/**
 * Contrato PÚBLICO de una playa para el conductor: subset estricto del modelo
 * (sin CUIT, contacto, settings ni nada operativo), DTO manual por AGENTS.md §4.
 */
export class DriverScheduleDto {
  @ApiProperty({ enum: ScheduleDay, enumName: 'ScheduleDay' })
  day: ScheduleDay;

  @ApiProperty({
    minimum: 0,
    maximum: 1440,
    description: 'Minutos desde 00:00.',
  })
  openMinute: number;

  @ApiProperty({
    minimum: 0,
    maximum: 1440,
    description: 'Minutos desde 00:00.',
  })
  closeMinute: number;
}

export class DriverReservationRulesDto {
  @ApiProperty({
    enum: ['auto', 'manual'],
    enumName: 'ReservationAcceptanceMode',
    description: 'auto = se confirma sola; manual = la acepta el dueño.',
  })
  acceptanceMode: string;

  @ApiProperty({
    description: 'Cancelación gratis hasta estos minutos antes del ingreso.',
  })
  freeCancelMinutes: number;

  @ApiProperty({
    description: '% que se reembolsa si se cancela fuera de la ventana gratis.',
  })
  lateCancelRefundPct: number;

  @ApiProperty({
    description: 'Minutos antes del ingreso desde los que se puede llegar.',
  })
  earlyArrivalMinutes: number;

  @ApiProperty({
    description:
      'Tolerancia tras la hora de ingreso; pasada, la reserva se da por perdida.',
  })
  graceMinutes: number;
}

export class DriverParkingDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: String, nullable: true })
  address: string | null;

  @ApiProperty({ type: Number })
  latitude: number;

  @ApiProperty({ type: Number })
  longitude: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Lugares libres ahora: capacidad − vehículos adentro. null si la playa ' +
      'no declaró capacidad (no es lo mismo que 0).',
  })
  availableSpots: number | null;

  @ApiProperty({ type: Number, nullable: true })
  totalSpots: number | null;

  @ApiProperty({
    description:
      'Toma reservas: servicio activado, con tarifa de reservas y cupo configurados.',
  })
  acceptsReservations: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Precio de la hora de la tarifa de reservas en ARS, igual para cualquier ' +
      'vehículo. null si la playa no toma reservas.',
  })
  reservationHourPriceArs: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Precio de la fracción de 5 minutos de la tarifa de reservas en ARS. ' +
      'null si la playa no toma reservas.',
  })
  reservationFractionPriceArs: number | null;

  @ApiProperty({
    ...RESERVABLE_VEHICLE_CATEGORY_API_PROPERTY,
    isArray: true,
    nullable: true,
    description:
      'Categorías de vehículo que pueden reservar. null si la playa no toma reservas.',
  })
  reservationVehicleCategories: string[] | null;

  @ApiProperty({
    type: [DriverScheduleDto],
    nullable: true,
    description:
      'Horario efectivo de reservas por día: el de apertura si el dueño no ' +
      'cargó uno propio. null si la playa no toma reservas.',
  })
  reservationHours: DriverScheduleDto[] | null;

  @ApiProperty({
    type: DriverReservationRulesDto,
    nullable: true,
    description: 'Reglas de la reserva. null si la playa no toma reservas.',
  })
  reservationRules: DriverReservationRulesDto | null;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: 'null si la playa no cargó horarios.',
  })
  openNow: boolean | null;
}

export class DriverNearbyParkingDto extends DriverParkingDto {
  @ApiProperty({ type: Number, description: 'Distancia al centro buscado.' })
  distanceMeters: number;
}

export class DriverParkingDetailDto extends DriverParkingDto {
  @ApiProperty({
    type: [DriverScheduleDto],
    description: 'Rangos de apertura por día; vacío si no hay horarios.',
  })
  schedules: DriverScheduleDto[];

  @ApiProperty({
    type: Number,
    description: 'Días hacia adelante en los que se puede reservar.',
  })
  reservationMaxDaysAhead: number;
}

/** Resultado de la búsqueda por nombre: igual que el listado cercano. */
export class DriverParkingSearchResultDto extends DriverParkingDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Distancia en metros a las coordenadas enviadas. null si la búsqueda no trae coordenadas o la playa no tiene ubicación cargada.',
  })
  distanceMeters: number | null;
}
