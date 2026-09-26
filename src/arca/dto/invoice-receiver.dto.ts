import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class InvoiceReceiversQueryDto {
  @ApiPropertyOptional({
    description:
      'Con dígitos busca por el principio del CUIT; con letras, dentro de la ' +
      'razón social. Vacío: los más recientes.',
    maxLength: 60,
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit = 10;
}

/** Un CUIT ya facturado en la playa, para sugerirlo en el cobro. */
export class InvoiceReceiverDto {
  @ApiProperty({ example: '30712345671' })
  cuit: string;

  @ApiProperty({ nullable: true, type: String, example: 'EMPRESA SA' })
  razonSocial: string | null;

  @ApiProperty({ nullable: true, type: Number })
  condicionIvaReceptorId: number | null;

  @ApiProperty({ format: 'date-time' })
  lastUsedAt: Date;
}
