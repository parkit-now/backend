import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

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
}
