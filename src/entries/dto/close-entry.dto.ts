import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsUUID,
  Min,
} from 'class-validator';

export class CloseEntryDto {
  @ApiPropertyOptional({
    description:
      'Exit timestamp (ISO 8601). Defaults to now on the server if omitted.',
    format: 'date-time',
  })
  @IsOptional()
  @IsDateString()
  leftAt?: string;

  @ApiPropertyOptional({
    description: 'Amount paid in ARS.',
    type: Number,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amountPaid?: number;

  @ApiPropertyOptional({ description: 'Payment method used.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  paymentMethodId?: string;
}
