import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaymentLineDto } from '../../payment-transactions/dto/payment-line.dto';

export class CorrectEntryDto {
  @ApiPropertyOptional({ example: 'ABC123', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  plate?: string;

  @ApiPropertyOptional({ example: 'Rojo', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string;

  @ApiPropertyOptional({ example: 'Cochera 3', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  cochera?: string;

  @ApiPropertyOptional({ example: 'Cliente frecuente', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  enteredAt?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  leftAt?: string;

  @ApiPropertyOptional({ example: 'Volkswagen', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  vehicleBrand?: string;

  @ApiPropertyOptional({ example: 'Bora', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  vehicleModel?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  rateId?: string;

  @ApiPropertyOptional({ example: 'Tarifa Pick Up', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  rateSnapshotName?: string;

  @ApiPropertyOptional({ type: Number, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rateSnapshotHourPriceArs?: number;

  @ApiPropertyOptional({ type: Number, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rateSnapshotStayPriceArs?: number;

  @ApiPropertyOptional({ type: Number, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rateSnapshotFractionPriceArs?: number;

  @ApiPropertyOptional({
    description: 'Payment breakdown replacing the current active lines.',
    type: () => [PaymentLineDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentLineDto)
  payments?: PaymentLineDto[];

  @ApiPropertyOptional({
    description: 'Required for operator changes to ingreso, egreso or amounts.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
