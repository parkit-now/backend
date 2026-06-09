import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CloseCashSessionDto {
  @ApiProperty({
    description: 'Client-generated UUIDv7 for the new session.',
    format: 'uuid',
  })
  @IsUUID()
  newSessionId: string;

  @ApiPropertyOptional({
    description: 'Close timestamp. Defaults to now() on the server.',
    format: 'date-time',
  })
  @IsOptional()
  @IsDateString()
  closedAt?: string;

  @ApiPropertyOptional({
    description: 'Cash left in the drawer for the next shift. Defaults to 0.',
    type: Number,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  leavingCash?: number;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
