import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class IssueInvoiceDto {
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
