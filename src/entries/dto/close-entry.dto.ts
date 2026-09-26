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
    description:
      'Total amount paid in ARS. Computed from payments[] if provided; otherwise stored directly (legacy / offline fallback).',
    type: Number,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amountPaid?: number;

  @ApiPropertyOptional({
    description:
      'Payment breakdown per method. When provided, amountPaid is set to the sum.',
    type: () => [PaymentLineDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentLineDto)
  payments?: PaymentLineDto[];

  @ApiPropertyOptional({
    description:
      'CUIT del cliente para emitir Factura A (emisor Responsable Inscripto). ' +
      'Con o sin guiones. Un CUIT inválido no hace fallar el cierre: la factura ' +
      'queda pendiente con ARCA_CUIT_INVALID.',
    example: '30-71234567-1',
    maxLength: 13,
  })
  @IsOptional()
  @IsString()
  @MaxLength(13)
  invoiceReceiverCuit?: string;

  @ApiPropertyOptional({ description: 'Cash session ID.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  cashSessionId?: string;

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
}
