import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InvoiceSummaryDto } from './invoice-summary.dto';

/** Fila de `invoices` para el sync del desktop. */
export class InvoiceDto extends InvoiceSummaryDto {
  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty({ format: 'uuid' })
  entryId: string;

  @ApiProperty({ type: Number })
  impTotal: number;

  @ApiPropertyOptional({ nullable: true, type: Number })
  impNeto: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  impIva: number | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date' })
  cbteFch: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  issuedAt: Date | null;

  @ApiProperty()
  version: number;

  @ApiProperty()
  syncSeq: number;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}
