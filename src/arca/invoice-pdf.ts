import type { InvoiceData } from '@arcasdk/pdf';
import type { ArcaTaxCondition, Invoice } from '@prisma/client';
import { CbteTipos, DOC_TIPO_CUIT } from './resolve-voucher';

/** Condición del EMISOR, con el texto que usa ARCA en sus comprobantes. */
const EMISOR_CONDICION: Record<ArcaTaxCondition, string> = {
  responsable_inscripto: 'IVA Responsable Inscripto',
  monotributo: 'Responsable Monotributo',
  exento: 'IVA Sujeto Exento',
};

/** `CondicionIVAReceptorId` → texto (`FEParamGetCondicionIvaReceptor`). */
const RECEPTOR_CONDICION: Readonly<Record<number, string>> = {
  1: 'IVA Responsable Inscripto',
  4: 'IVA Sujeto Exento',
  5: 'Consumidor Final',
  6: 'Responsable Monotributo',
  7: 'Sujeto No Categorizado',
  8: 'Proveedor del Exterior',
  9: 'Cliente del Exterior',
  10: 'IVA Liberado – Ley N° 19.640',
  13: 'Monotributista Social',
  15: 'IVA No Alcanzado',
  16: 'Monotributo Trabajador Independiente Promovido',
};

const LETTER_BY_TIPO: Readonly<Record<number, string>> = {
  [CbteTipos.A]: 'A',
  [CbteTipos.B]: 'B',
  [CbteTipos.C]: 'C',
};

const AR_DATE_TIME = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const ARS = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Una factura emitida, con todo lo que el PDF necesita. */
export type IssuedInvoice = Invoice & {
  cbteTipo: number;
  ptoVta: number;
  cbteNro: number;
  cae: string;
  caeVto: Date;
  cbteFch: Date;
  emisorCuit: string;
};

export function isPrintable(invoice: Invoice): invoice is IssuedInvoice {
  return (
    invoice.status === 'issued' &&
    invoice.cbteTipo !== null &&
    LETTER_BY_TIPO[invoice.cbteTipo] !== undefined &&
    invoice.ptoVta !== null &&
    invoice.cbteNro !== null &&
    invoice.cae !== null &&
    invoice.caeVto !== null &&
    invoice.cbteFch !== null &&
    invoice.emisorCuit !== null
  );
}

/**
 * Arma los datos del PDF a partir de la factura emitida, SÓLO con lo que se
 * guardó al emitir (la foto del emisor): si el dueño después cambia la razón
 * social o el domicilio, el comprobante de ese día sigue diciendo lo mismo.
 *
 * - **A:** precio neto, IVA discriminado por alícuota.
 * - **B:** precio con IVA incluido y, abajo, la leyenda del Régimen de
 *   Transparencia Fiscal al Consumidor con el IVA contenido. La plantilla
 *   muestra `importeNetoGravado` como «Subtotal», por eso va el total.
 * - **C:** el total, sin IVA.
 */
export function buildInvoicePdfData(
  invoice: IssuedInvoice,
  entry: { plate: string; enteredAt: Date; leftAt: Date | null },
): InvoiceData {
  const letter = LETTER_BY_TIPO[invoice.cbteTipo];
  const total = Number(invoice.impTotal);
  const neto = invoice.impNeto === null ? total : Number(invoice.impNeto);
  const iva = invoice.impIva === null ? 0 : Number(invoice.impIva);
  const rate = invoice.ivaRate === null ? null : Number(invoice.ivaRate);
  const discriminaIva = letter === 'A' && rate !== null;
  const itemPrice = discriminaIva ? neto : total;
  const withCuit =
    invoice.receptorDocTipo === DOC_TIPO_CUIT && !!invoice.receptorDocNro;

  return {
    emisor: {
      razonSocial: invoice.emisorRazonSocial ?? '',
      domicilioComercial: invoice.emisorDomicilio ?? '',
      condicionIva: invoice.emisorCondicionIva
        ? EMISOR_CONDICION[invoice.emisorCondicionIva]
        : '',
      cuit: invoice.emisorCuit,
      iibb: invoice.emisorIibb ?? '',
      fechaInicioActividades: invoice.emisorInicioActividad
        ? arcaDate(invoice.emisorInicioActividad)
        : '',
    },
    receptor: {
      razonSocial: invoice.receptorNombre ?? 'Consumidor Final',
      condicionIva:
        RECEPTOR_CONDICION[invoice.receptorCondicionIvaId ?? 5] ??
        'Consumidor Final',
      documentoTipo: withCuit ? 'CUIT' : 'Sin Identificar',
      documentoNro: withCuit ? invoice.receptorDocNro! : '0',
    },
    cbteTipo: invoice.cbteTipo,
    cbteLetra: letter,
    puntoVenta: invoice.ptoVta,
    cbteDesde: invoice.cbteNro,
    cbteHasta: invoice.cbteNro,
    cbteFecha: arcaDate(invoice.cbteFch),
    concepto: 2,
    moneda: 'PES',
    cotizacion: 1,
    condicionVenta: 'Contado',
    ...(invoice.fchServDesde && {
      fechaServicioDesde: arcaDate(invoice.fchServDesde),
    }),
    ...(invoice.fchServHasta && {
      fechaServicioHasta: arcaDate(invoice.fchServHasta),
    }),
    fechaVtoPago: arcaDate(invoice.cbteFch),
    items: [
      {
        descripcion: stayDescription(entry),
        cantidad: 1,
        unidadMedida: 'unidades',
        precioUnitario: itemPrice,
        subtotal: itemPrice,
        ...(discriminaIva && { alicuotaIva: rate }),
      },
    ],
    importeNetoGravado: discriminaIva ? neto : total,
    ...(discriminaIva && {
      iva: [
        {
          id: 0,
          descripcion: `${rate}%`,
          baseImponible: neto,
          importe: iva,
        },
      ],
    }),
    importeIva: discriminaIva ? iva : 0,
    importeTotal: total,
    cae: invoice.cae,
    caeFechaVencimiento: arcaDate(invoice.caeVto),
    ...(letter === 'B' &&
      iva > 0 && {
        observaciones: `Régimen de Transparencia Fiscal al Consumidor (Ley 27.743) – IVA contenido: $${ARS.format(iva)}`,
      }),
  };
}

/** `0001-00000001-B.pdf`-style: tipo, punto de venta y número. */
export function invoicePdfFileName(invoice: IssuedInvoice): string {
  const letter = LETTER_BY_TIPO[invoice.cbteTipo];
  const pv = String(invoice.ptoVta).padStart(4, '0');
  const nro = String(invoice.cbteNro).padStart(8, '0');
  return `factura-${letter}-${pv}-${nro}.pdf`;
}

/** «Estadía AB123CD – 24/09/2026 10:00 a 24/09/2026 12:30». */
function stayDescription(entry: {
  plate: string;
  enteredAt: Date;
  leftAt: Date | null;
}): string {
  const from = dateTime(entry.enteredAt);
  return entry.leftAt
    ? `Estadía ${entry.plate} – ${from} a ${dateTime(entry.leftAt)}`
    : `Estadía ${entry.plate} – desde ${from}`;
}

/** Columna `@db.Date` (00:00 UTC) → `AAAAMMDD`. */
function arcaDate(value: Date): string {
  return value.toISOString().slice(0, 10).replace(/-/g, '');
}

/** `24/09/2026 10:00` en hora argentina (sin la coma de `es-AR`). */
function dateTime(value: Date): string {
  return AR_DATE_TIME.format(value).replace(',', '');
}
