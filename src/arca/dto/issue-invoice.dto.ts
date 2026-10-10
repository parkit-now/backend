import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class IssueInvoiceDto {
  @ApiPropertyOptional({
    description:
      'IDs de los pagos incluidos en esta factura. Se omite para conservar la selección previa o facturar el total.',
    type: [String],
    format: 'uuid',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  invoicePaymentIds?: string[];

  @ApiPropertyOptional({
    description: 'Importe confirmado por el operador. Si cambio, no se emite.',
    minimum: 0,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  expectedAmount?: number;

  @ApiPropertyOptional({
    description:
      'CUIT del cliente, con o sin guiones. La letra la decide el padrón: A ' +
      'si el emisor es RI y el receptor RI o monotributista; si no, B o C ' +
      'identificada con el CUIT. Sin él se emite a consumidor final.',
    example: '30-71234567-1',
    maxLength: 13,
  })
  @IsOptional()
  @IsString()
  @MaxLength(13)
  receiverCuit?: string;
}
