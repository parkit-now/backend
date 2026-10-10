import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsUUID,
  IsOptional,
} from 'class-validator';
import { InvoiceSummaryDto } from './invoice-summary.dto';

/** Tope del lote: se emite de a una, y cada una puede tardar segundos. */
export const INVOICE_BATCH_MAX = 50;

export class IssueInvoiceBatchDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  arcaAccountId?: string;
  @ApiProperty({
    description: `Estadías cobradas a facturar a consumidor final (1 a ${INVOICE_BATCH_MAX}).`,
    type: [String],
    format: 'uuid',
    maxItems: INVOICE_BATCH_MAX,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(INVOICE_BATCH_MAX)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  entryIds: string[];
}

export class InvoiceBatchItemDto {
  @ApiProperty({ format: 'uuid' })
  entryId: string;

  @ApiPropertyOptional({
    nullable: true,
    type: () => InvoiceSummaryDto,
    description: 'La factura como quedó; null si ni se intentó.',
  })
  invoice: InvoiceSummaryDto | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'Por qué no salió: el `errorCode` de la factura o el del conflicto ' +
      '(INVOICE_ALREADY_ISSUED, INVOICE_NOT_INVOICEABLE, …). null si se emitió.',
  })
  errorCode: string | null;
}

export class InvoiceBatchResponseDto {
  @ApiProperty({ type: () => [InvoiceBatchItemDto] })
  results: InvoiceBatchItemDto[];
}
