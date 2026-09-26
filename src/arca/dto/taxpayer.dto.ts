import { ApiProperty } from '@nestjs/swagger';

/**
 * Qué factura sale si el cliente da este CUIT: lo que el cobro le muestra al
 * operario antes de confirmar.
 */
export class TaxpayerDto {
  @ApiProperty({ example: '30712345671', description: 'Sólo dígitos.' })
  cuit: string;

  @ApiProperty({
    description:
      'Si la factura sale identificada con este CUIT. `false` = ARCA no tiene ' +
      'datos del CUIT (producción): la factura va a consumidor final.',
  })
  identified: boolean;

  @ApiProperty({
    enum: ['A', 'B', 'C'],
    description:
      'La letra que sale: A si el emisor es RI y el receptor RI o ' +
      'monotributista; C siempre para un emisor monotributista o exento.',
  })
  letter: 'A' | 'B' | 'C';

  @ApiProperty({ nullable: true, type: String, example: 'EMPRESA SA' })
  razonSocial: string | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      '`CondicionIVAReceptorId` de ARCA. `null` si no se identifica.',
  })
  condicionIvaReceptorId: number | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: 'IVA Responsable Inscripto',
  })
  condicionIva: string | null;

  @ApiProperty({
    description:
      'Homologación: ARCA no tiene datos de prueba de este CUIT y se tomó ' +
      'como Responsable Inscripto para poder probar la Factura A.',
  })
  assumed: boolean;
}
