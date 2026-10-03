import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { RESERVATION_VEHICLE_KINDS } from '../reservation-readiness';

export class UpdateServiceDto {
  @ApiPropertyOptional({
    description: 'Whether the amenity is offered by the tenant.',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Sólo ADVANCE_RESERVATION: id de una tarifa activa de la playa con la ' +
      'que se cotizan y cobran las reservas. null la desasocia.',
    format: 'uuid',
    nullable: true,
    type: String,
  })
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsUUID()
  reservationRateId?: string | null;

  @ApiPropertyOptional({
    description:
      'Sólo ADVANCE_RESERVATION: plazas que se pueden reservar a la vez, hasta ' +
      'la capacidad de la playa. null lo deja sin configurar.',
    nullable: true,
    type: Number,
    minimum: 0,
    maximum: 10000,
  })
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  reservableSpots?: number | null;

  @ApiPropertyOptional({
    description:
      'Sólo ADVANCE_RESERVATION: tipos de vehículo que pueden reservar, sin ' +
      'duplicados.',
    enum: RESERVATION_VEHICLE_KINDS,
    enumName: 'ReservationVehicleKind',
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(RESERVATION_VEHICLE_KINDS, { each: true })
  reservationVehicleKinds?: string[];

  @ApiPropertyOptional({
    description:
      'Sólo ADVANCE_RESERVATION: auto = se confirma sola; manual = la acepta el dueño.',
    enum: ['auto', 'manual'],
    enumName: 'ReservationAcceptanceMode',
  })
  @IsOptional()
  @IsIn(['auto', 'manual'])
  acceptanceMode?: string;

  @ApiPropertyOptional({
    description:
      'Sólo ADVANCE_RESERVATION: minutos para aceptar (modo manual).',
    minimum: 5,
    maximum: 120,
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(120)
  approvalWindowMinutes?: number;

  @ApiPropertyOptional({
    description: 'Sólo ADVANCE_RESERVATION: cancelación gratis, en minutos.',
    minimum: 0,
    maximum: 1440,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  freeCancelMinutes?: number;

  @ApiPropertyOptional({
    description:
      'Sólo ADVANCE_RESERVATION: % de reembolso en cancelación tardía.',
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  lateCancelRefundPct?: number;

  @ApiPropertyOptional({
    description: 'Sólo ADVANCE_RESERVATION: llegada anticipada, en minutos.',
    minimum: 0,
    maximum: 120,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  earlyArrivalMinutes?: number;

  @ApiPropertyOptional({
    description: 'Sólo ADVANCE_RESERVATION: tolerancia de no-show, en minutos.',
    minimum: 0,
    maximum: 180,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(180)
  graceMinutes?: number;
}
