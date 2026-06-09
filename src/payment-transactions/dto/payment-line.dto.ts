import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class PaymentLineDto {
  @ApiProperty({
    description: 'Client-generated UUIDv7 for offline-first support.',
    format: 'uuid',
  })
  @IsUUID()
  id: string;

  @ApiPropertyOptional({
    description: 'Payment method ID (may be absent if PM was deleted).',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  paymentMethodId?: string;

  @ApiProperty({ example: 'Efectivo', maxLength: 120 })
  @IsString()
  @MaxLength(120)
  paymentMethodName: string;

  @ApiProperty({ type: Number, minimum: 0 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount: number;
}
