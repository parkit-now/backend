import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InvoiceStatus } from '@prisma/client';

/** Lo que el cobro necesita saber de la factura: cómo salió y por qué. */
export class InvoiceSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: InvoiceStatus, enumName: 'InvoiceStatus' })
  status: InvoiceStatus;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: 'Código de ARCA: 1 = A, 6 = B, 11 = C.',
  })
  cbteTipo: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  ptoVta: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  cbteNro: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: '86380920935994',
  })
  cae: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date',
    description: 'Vencimiento del CAE (AAAA-MM-DD).',
  })
  caeVto: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Código estable (`ARCA_*` / `INVOICE_*`) del último problema.',
  })
  errorCode: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Detalle, por ejemplo las observaciones de ARCA al rechazar.',
  })
  errorMessage: string | null;
}
