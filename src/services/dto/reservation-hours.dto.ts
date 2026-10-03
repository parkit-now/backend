import { ApiProperty } from '@nestjs/swagger';
import { ScheduleDay } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ProblemDetailsDto } from '../../utils/exceptions/dto/problem-details.dto';
import { RESERVATION_HOURS_MODES } from '../reservation-readiness';

export class ReservationHourRangeDto {
  @ApiProperty({ enum: ScheduleDay, enumName: 'ScheduleDay' })
  @IsEnum(ScheduleDay)
  day: ScheduleDay;

  @ApiProperty({
    minimum: 0,
    maximum: 1439,
    description: 'Minutos desde 00:00.',
  })
  @IsInt()
  @Min(0)
  @Max(1439)
  openMinute: number;

  @ApiProperty({
    minimum: 1,
    maximum: 1440,
    description: 'Minutos desde 00:00.',
  })
  @IsInt()
  @Min(1)
  @Max(1440)
  closeMinute: number;
}

/** Horario de reservas: `GET` lo devuelve y `PUT` lo reemplaza completo. */
export class ReservationHoursDto {
  @ApiProperty({
    enum: RESERVATION_HOURS_MODES,
    enumName: 'ReservationHoursMode',
    description:
      'opening = el horario de apertura (sin rangos propios); custom = los ' +
      'rangos de `ranges`, que tienen que caer dentro de la apertura.',
  })
  @IsIn(RESERVATION_HOURS_MODES)
  mode: string;

  @ApiProperty({
    type: [ReservationHourRangeDto],
    description: 'Rangos propios; siempre vacío en modo opening.',
  })
  @IsArray()
  @ArrayMaxSize(70)
  @ValidateNested({ each: true })
  @Type(() => ReservationHourRangeDto)
  ranges: ReservationHourRangeDto[];
}

/** 422 SERVICE_RESERVATION_NOT_READY: ProblemDetails + lo que falta. */
export class ReservationNotReadyProblemDto extends ProblemDetailsDto {
  @ApiProperty({
    enum: ['mp_account', 'spots', 'hours', 'vehicles', 'rate'],
    enumName: 'ReservationRequirement',
    isArray: true,
    description: 'Requisitos que faltan para activar las reservas.',
  })
  missing: string[];

  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      properties: {
        field: { type: 'string', example: 'readiness.mp_account' },
        reason: { type: 'string' },
        code: { type: 'string', example: 'required' },
      },
    },
    description:
      'Un ítem por requisito faltante (patrón de validationsErrors).',
  })
  validationsErrors: { field: string; reason: string; code: string }[];
}
