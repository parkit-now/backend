import { ApiProperty } from '@nestjs/swagger';

export class InvoiceDocumentEmisorDto {
  @ApiProperty({ example: 'DE LA CRUZ JUAN MARTIN' })
  razonSocial: string;

  @ApiProperty({ example: 'AV SIEMPRE VIVA 742, CABA' })
  domicilioComercial: string;

  @ApiProperty({ example: 'IVA Responsable Inscripto' })
  condicionIva: string;

  @ApiProperty({ example: '20447275865', description: 'Sólo dígitos.' })
  cuit: string;

  @ApiProperty({ example: '901-000000-0' })
  iibb: string;

  @ApiProperty({ nullable: true, type: String, example: '2020-01-01' })
  fechaInicioActividades: string | null;
}

export class InvoiceDocumentReceptorDto {
  @ApiProperty({ example: 'Consumidor Final' })
  razonSocial: string;

  @ApiProperty({ example: 'Consumidor Final' })
  condicionIva: string;

  @ApiProperty({ enum: ['CUIT', 'Sin Identificar'] })
  documentoTipo: 'CUIT' | 'Sin Identificar';

  @ApiProperty({ example: '0', description: '`0` si no se identifica.' })
  documentoNro: string;
}

export class InvoiceDocumentItemDto {
  @ApiProperty({
    example: 'Estadía AB123CD – 24/09/2026 10:00 a 24/09/2026 12:30',
  })
  descripcion: string;

  @ApiProperty({ example: 1 })
  cantidad: number;

  @ApiProperty({ example: 'unidades' })
  unidadMedida: string;

  @ApiProperty({ example: 1210 })
  precioUnitario: number;

  @ApiProperty({ example: 1210 })
  subtotal: number;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Sólo en la Factura A, que discrimina IVA.',
  })
  alicuotaIva: number | null;
}

export class InvoiceDocumentIvaDto {
  @ApiProperty({ example: '21%' })
  descripcion: string;

  @ApiProperty({ example: 1000 })
  baseImponible: number;

  @ApiProperty({ example: 210 })
  importe: number;
}

/**
 * Lo que hace falta para dibujar el comprobante de una factura emitida. El
 * PDF lo arma el desktop; las fechas van `AAAA-MM-DD`.
 */
export class InvoiceDocumentDto {
  @ApiProperty({ type: InvoiceDocumentEmisorDto })
  emisor: InvoiceDocumentEmisorDto;

  @ApiProperty({ type: InvoiceDocumentReceptorDto })
  receptor: InvoiceDocumentReceptorDto;

  @ApiProperty({ example: 6, description: '1 = A, 6 = B, 11 = C.' })
  cbteTipo: number;

  @ApiProperty({ enum: ['A', 'B', 'C'] })
  cbteLetra: 'A' | 'B' | 'C';

  @ApiProperty({ example: 1 })
  puntoVenta: number;

  @ApiProperty({ example: 7 })
  cbteNro: number;

  @ApiProperty({ example: '2026-09-24' })
  cbteFecha: string;

  @ApiProperty({ example: 'Contado' })
  condicionVenta: string;

  @ApiProperty({ nullable: true, type: String, example: '2026-09-24' })
  fechaServicioDesde: string | null;

  @ApiProperty({ nullable: true, type: String, example: '2026-09-24' })
  fechaServicioHasta: string | null;

  @ApiProperty({ example: '2026-09-24' })
  fechaVtoPago: string;

  @ApiProperty({ type: [InvoiceDocumentItemDto] })
  items: InvoiceDocumentItemDto[];

  @ApiProperty({
    example: 1210,
    description:
      'En la B y la C, el total (la plantilla lo muestra como «Subtotal»).',
  })
  importeNetoGravado: number;

  @ApiProperty({
    type: [InvoiceDocumentIvaDto],
    description: 'Sólo en la Factura A; vacío en la B y la C.',
  })
  iva: InvoiceDocumentIvaDto[];

  @ApiProperty({ example: 0 })
  importeIva: number;

  @ApiProperty({ example: 1210 })
  importeTotal: number;

  @ApiProperty({ example: '86390926440543' })
  cae: string;

  @ApiProperty({ example: '2026-10-04' })
  caeFechaVencimiento: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'En la B, la leyenda del Régimen de Transparencia Fiscal al Consumidor.',
  })
  observaciones: string | null;

  @ApiProperty({
    example: 'https://www.afip.gob.ar/fe/qr/?p=eyJ2ZXIiOjF9',
    description: 'El link del QR de la RG 4892, ya armado.',
  })
  qrUrl: string;
}
