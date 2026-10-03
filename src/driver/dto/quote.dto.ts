import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsOptional, IsString, Matches } from 'class-validator';
import { normalizePlate } from '../driver-rules';

export class CreateQuoteDto {
  @ApiProperty({ format: 'date-time', example: '2026-09-30T10:00:00-03:00' })
  @IsDateString()
  entryAt: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-30T13:00:00-03:00' })
  @IsDateString()
  exitAt: string;

  @ApiPropertyOptional({
    example: 'AB123CD',
    description:
      'Patente de uno de tus vehículos. Si se manda, la cotización valida que ' +
      'la playa acepte ese tipo de vehículo (RESERVATION_VEHICLE_KIND_NOT_ACCEPTED).',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizePlate(value) : value,
  )
  @IsString()
  @Matches(/^[A-Z0-9]{3,10}$/)
  vehiclePlate?: string;
}

export class QuoteRateDto {
  @ApiProperty()
  name: string;

  @ApiProperty({ type: Number })
  hourPriceArs: number;

  @ApiProperty({ type: Number })
  fractionPriceArs: number;

  @ApiProperty({ type: Number, description: 'Tope de 12 h (0 = sin tope).' })
  mediaEstadiaPriceArs: number;

  @ApiProperty({ type: Number, description: 'Tope de 24 h (0 = sin tope).' })
  stayPriceArs: number;
}

export class QuoteDto {
  @ApiProperty({ format: 'uuid' })
  parkingId: string;

  @ApiProperty({ format: 'date-time' })
  entryAt: string;

  @ApiProperty({ format: 'date-time' })
  exitAt: string;

  @ApiProperty({ type: Number })
  durationMinutes: number;

  @ApiProperty({
    type: Number,
    description:
      'Total en ARS con el mismo motor que cobra la playa (entries/pricing.ts).',
  })
  totalArs: number;

  @ApiProperty({
    type: QuoteRateDto,
    description: 'Tarifa de reservas de la playa con la que se cotizó.',
  })
  rate: QuoteRateDto;
}
