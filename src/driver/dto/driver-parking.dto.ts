import { ApiProperty } from '@nestjs/swagger';
import { ScheduleDay } from '@prisma/client';

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
