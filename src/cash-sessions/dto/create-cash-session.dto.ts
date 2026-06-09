import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateCashSessionDto {
  @ApiProperty({
    description: 'Client-generated UUIDv7 for offline-first support.',
    format: 'uuid',
  })
  @IsUUID()
  id: string;

  @ApiProperty({
    description: 'When the session was opened (ISO 8601).',
    format: 'date-time',
  })
  @IsDateString()
  openedAt: string;

  @ApiPropertyOptional({
    description: 'Opening cash float in ARS. Defaults to 0.',
    type: Number,
    minimum: 0,
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  openingCash?: number;
}
