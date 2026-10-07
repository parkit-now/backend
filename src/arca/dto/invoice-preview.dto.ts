import { ApiProperty } from '@nestjs/swagger';

export class InvoicePreviewDto {
  @ApiProperty({
    description: 'Importe vigente que se enviara a ARCA, en pesos.',
  })
  amount: number;
}
