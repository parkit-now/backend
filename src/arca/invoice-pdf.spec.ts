import type { Invoice } from '@prisma/client';
import {
  buildInvoicePdfData,
  invoicePdfFileName,
  isPrintable,
  type IssuedInvoice,
} from './invoice-pdf';

const ENTRY = {
  plate: 'AB123CD',
  enteredAt: new Date('2026-09-24T13:00:00.000Z'),
  leftAt: new Date('2026-09-24T15:30:00.000Z'),
};

function invoice(extra: Partial<Invoice> = {}): IssuedInvoice {
  return {
    status: 'issued',
    cbteTipo: 6,
    ptoVta: 1,
    cbteNro: 7,
    cae: '86390926440543',
    caeVto: new Date('2026-10-04T00:00:00.000Z'),
    cbteFch: new Date('2026-09-24T00:00:00.000Z'),
    fchServDesde: new Date('2026-09-24T00:00:00.000Z'),
    fchServHasta: new Date('2026-09-24T00:00:00.000Z'),
    emisorCuit: '20447275865',
    emisorRazonSocial: 'DE LA CRUZ JUAN MARTIN',
    emisorDomicilio: 'Calle 123, CABA',
    emisorCondicionIva: 'responsable_inscripto',
    emisorIibb: '901-000000-0',
    emisorInicioActividad: new Date('2020-01-01T00:00:00.000Z'),
    receptorDocTipo: 99,
    receptorDocNro: '0',
    receptorNombre: 'Consumidor Final',
    receptorCondicionIvaId: 5,
    impTotal: 1210,
    impNeto: 1000,
    impIva: 210,
    ivaRate: 21,
    ...extra,
  } as unknown as IssuedInvoice;
}

describe('buildInvoicePdfData', () => {
  it('B: precio con IVA incluido y leyenda de transparencia fiscal', () => {
    const data = buildInvoicePdfData(invoice(), ENTRY);

    expect(data.cbteLetra).toBe('B');
    expect(data.items[0]).toMatchObject({
      precioUnitario: 1210,
      subtotal: 1210,
      descripcion: 'Estadía AB123CD – 24/09/2026 10:00 a 24/09/2026 12:30',
    });
    expect(data.iva).toBeUndefined();
    expect(data.observaciones).toContain('Ley 27.743');
    expect(data.observaciones).toContain('$210,00');
    expect(data.receptor.documentoTipo).toBe('Sin Identificar');
  });

  it('A: precio neto e IVA discriminado, receptor con CUIT', () => {
    const data = buildInvoicePdfData(
      invoice({
        cbteTipo: 1,
        receptorDocTipo: 80,
        receptorDocNro: '30712345671',
        receptorNombre: 'EMPRESA SA',
        receptorCondicionIvaId: 1,
      }),
      ENTRY,
    );

    expect(data.cbteLetra).toBe('A');
    expect(data.items[0]).toMatchObject({
      precioUnitario: 1000,
      alicuotaIva: 21,
    });
    expect(data.iva).toEqual([
      { id: 0, descripcion: '21%', baseImponible: 1000, importe: 210 },
    ]);
    expect(data.receptor).toMatchObject({
      documentoTipo: 'CUIT',
      documentoNro: '30712345671',
      condicionIva: 'IVA Responsable Inscripto',
    });
    expect(data.observaciones).toBeUndefined();
  });

  it('C: el total, sin IVA ni leyenda', () => {
    const data = buildInvoicePdfData(
      invoice({
        cbteTipo: 11,
        emisorCondicionIva: 'monotributo',
        impNeto: 1210 as never,
        impIva: 0 as never,
        ivaRate: null,
      }),
      ENTRY,
    );

    expect(data.cbteLetra).toBe('C');
    expect(data.emisor.condicionIva).toBe('Responsable Monotributo');
    expect(data.importeIva).toBe(0);
    expect(data.iva).toBeUndefined();
    expect(data.observaciones).toBeUndefined();
  });

  it('usa la foto del emisor guardada en la factura', () => {
    const data = buildInvoicePdfData(invoice(), ENTRY);

    expect(data.emisor).toMatchObject({
      razonSocial: 'DE LA CRUZ JUAN MARTIN',
      cuit: '20447275865',
      fechaInicioActividades: '20200101',
    });
    expect(data.caeFechaVencimiento).toBe('20261004');
  });
});

describe('buildInvoicePdfData — datos que faltaban en la foto', () => {
  it('rellena IIBB e inicio desde la cuenta sólo si la foto no los tiene', () => {
    const missing = {
      iibb: 'Exento',
      inicioActividad: new Date('2019-05-01T00:00:00.000Z'),
    };

    const sinFoto = buildInvoicePdfData(
      invoice({ emisorIibb: null, emisorInicioActividad: null }),
      ENTRY,
      missing,
    );
    const conFoto = buildInvoicePdfData(invoice(), ENTRY, missing);

    expect(sinFoto.emisor).toMatchObject({
      iibb: 'Exento',
      fechaInicioActividades: '20190501',
    });
    expect(conFoto.emisor).toMatchObject({
      iibb: '901-000000-0',
      fechaInicioActividades: '20200101',
    });
  });
});

describe('isPrintable / invoicePdfFileName', () => {
  it('sólo una factura emitida con CAE tiene PDF', () => {
    expect(isPrintable(invoice())).toBe(true);
    expect(isPrintable(invoice({ status: 'error' }))).toBe(false);
    expect(isPrintable(invoice({ cae: null }))).toBe(false);
  });

  it('nombra el archivo con patente, CAE y número de comprobante', () => {
    expect(invoicePdfFileName(invoice(), 'ab 123 cd')).toBe(
      'AB123CD-86390926440543-0001-00000007.pdf',
    );
  });
});
