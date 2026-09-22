import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class CloseCashSessionDto {
  @ApiPropertyOptional({
    description:
      'Whether to open the next cash session immediately. Defaults to false.',
    type: Boolean,
  })
  @IsOptional()
  @IsBoolean()
  openNextSession?: boolean;

  @ApiPropertyOptional({
    description:
      'Client-generated UUIDv7 for the new session. Required when openNextSession is true.',
    format: 'uuid',
  })
  @ValidateIf((dto: CloseCashSessionDto) => dto.openNextSession === true)
  @IsUUID()
  newSessionId?: string;

  @ApiPropertyOptional({
    description: 'Close timestamp. Defaults to now() on the server.',
    format: 'date-time',
  })
  @IsOptional()
  @IsDateString()
  closedAt?: string;

  @ApiPropertyOptional({
    description:
      'Cash left in the drawer for the next shift. Used only when openNextSession is true.',
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
