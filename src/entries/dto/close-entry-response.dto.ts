import { ApiPropertyOptional } from '@nestjs/swagger';
import { InvoiceSummaryDto } from '../../arca/dto/invoice-summary.dto';
import { EntryDto } from './entry.dto';

export class CloseEntryResponseDto extends EntryDto {
  @ApiPropertyOptional({
    type: () => InvoiceSummaryDto,
    nullable: true,
    description:
      'Factura de la estadía. `null` si la playa no factura con ARCA. Un ' +
      'problema al emitir NO hace fallar el cierre: viene en `status`/`errorCode`.',
  })
  invoice: InvoiceSummaryDto | null;
}
