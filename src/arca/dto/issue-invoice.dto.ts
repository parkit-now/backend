import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class IssueInvoiceDto {
  @ApiPropertyOptional({
    description:
      'CUIT del cliente para emitir Factura A (emisor Responsable Inscripto), ' +
      'con o sin guiones. Sin él se emite a consumidor final.',
    example: '30-71234567-1',
    maxLength: 13,
  })
  @IsOptional()
  @IsString()
  @MaxLength(13)
  receiverCuit?: string;
}
