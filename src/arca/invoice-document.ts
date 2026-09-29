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

export type InvoiceLetter = 'A' | 'B' | 'C';

const LETTER_BY_TIPO: Readonly<Record<number, InvoiceLetter>> = {
  [CbteTipos.A]: 'A',
  [CbteTipos.B]: 'B',
  [CbteTipos.C]: 'C',
};

/** Tipo de documento del receptor, como lo pide el QR (RG 4892). */
const DOC_TIPO_SIN_IDENTIFICAR = 99;

const ARCA_QR_BASE_URL = 'https://www.afip.gob.ar/fe/qr/';

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

/**
 * Todo lo que el desktop necesita para dibujar el comprobante (el PDF lo arma
 * él, ver `invoiceDocument.ts` en front-desktop). Las fechas van `AAAA-MM-DD`.
 */
export interface InvoiceDocument {
  readonly emisor: {
    readonly razonSocial: string;
    readonly domicilioComercial: string;
    readonly condicionIva: string;
    readonly cuit: string;
    readonly iibb: string;
    readonly fechaInicioActividades: string | null;
  };
  readonly receptor: {
    readonly razonSocial: string;
    readonly condicionIva: string;
    readonly documentoTipo: 'CUIT' | 'Sin Identificar';
    readonly documentoNro: string;
  };
  readonly cbteTipo: number;
  readonly cbteLetra: InvoiceLetter;
  readonly puntoVenta: number;
  readonly cbteNro: number;
  readonly cbteFecha: string;
  readonly condicionVenta: string;
  readonly fechaServicioDesde: string | null;
  readonly fechaServicioHasta: string | null;
  readonly fechaVtoPago: string;
  readonly items: {
    readonly descripcion: string;
    readonly cantidad: number;
    readonly unidadMedida: string;
    readonly precioUnitario: number;
    readonly subtotal: number;
    /** Sólo en la A, que discrimina IVA. */
    readonly alicuotaIva: number | null;
  }[];
  readonly importeNetoGravado: number;
  /** Sólo en la A: el IVA por alícuota. */
  readonly iva: {
    readonly descripcion: string;
    readonly baseImponible: number;
    readonly importe: number;
  }[];
  readonly importeIva: number;
  readonly importeTotal: number;
  readonly cae: string;
  readonly caeFechaVencimiento: string;
  readonly observaciones: string | null;
  /** El link del QR que exige la RG 4892, ya armado. */
  readonly qrUrl: string;
}

/** Una factura emitida, con todo lo que el comprobante necesita. */
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
 * Arma el comprobante a partir de la factura emitida, SÓLO con lo que se
 * guardó al emitir (la foto del emisor): si el dueño después cambia la razón
 * social o el domicilio, el comprobante de ese día sigue diciendo lo mismo.
 *
 * - **A:** precio neto, IVA discriminado por alícuota.
 * - **B:** precio con IVA incluido y, abajo, la leyenda del Régimen de
 *   Transparencia Fiscal al Consumidor con el IVA contenido. La plantilla
 *   muestra `importeNetoGravado` como «Subtotal», por eso va el total.
 * - **C:** el total, sin IVA.
 */
export function buildInvoiceDocument(
  invoice: IssuedInvoice,
  entry: { plate: string; enteredAt: Date; leftAt: Date | null },
  /**
   * IIBB e inicio de actividades de la cuenta HOY, sólo para rellenar lo que
   * la foto no tiene: facturas emitidas antes de que esos datos fueran
   * obligatorios. Completar un dato que faltaba no es cambiar lo que decía;
   * lo que sí estaba en la foto no se pisa.
   */
  missing: { iibb: string | null; inicioActividad: Date | null } = {
    iibb: null,
    inicioActividad: null,
  },
): InvoiceDocument {
  const iibb = invoice.emisorIibb ?? missing.iibb;
  const inicioActividad =
    invoice.emisorInicioActividad ?? missing.inicioActividad;
  const letter = LETTER_BY_TIPO[invoice.cbteTipo];
  const total = Number(invoice.impTotal);
  const neto = invoice.impNeto === null ? total : Number(invoice.impNeto);
  const iva = invoice.impIva === null ? 0 : Number(invoice.impIva);
  const rate = invoice.ivaRate === null ? null : Number(invoice.ivaRate);
  const discriminaIva = letter === 'A' && rate !== null;
  const itemPrice = discriminaIva ? neto : total;
  const withCuit =
    invoice.receptorDocTipo === DOC_TIPO_CUIT && !!invoice.receptorDocNro;
  const receptorDocNro = withCuit ? invoice.receptorDocNro! : '0';
  const cbteFecha = isoDate(invoice.cbteFch);

  return {
    emisor: {
      razonSocial: invoice.emisorRazonSocial ?? '',
      domicilioComercial: invoice.emisorDomicilio ?? '',
      condicionIva: invoice.emisorCondicionIva
        ? EMISOR_CONDICION[invoice.emisorCondicionIva]
        : '',
      cuit: invoice.emisorCuit,
      iibb: iibb ?? '',
      fechaInicioActividades: inicioActividad ? isoDate(inicioActividad) : null,
    },
    receptor: {
      razonSocial: invoice.receptorNombre ?? 'Consumidor Final',
      condicionIva:
        RECEPTOR_CONDICION[invoice.receptorCondicionIvaId ?? 5] ??
        'Consumidor Final',
      documentoTipo: withCuit ? 'CUIT' : 'Sin Identificar',
      documentoNro: receptorDocNro,
    },
    cbteTipo: invoice.cbteTipo,
    cbteLetra: letter,
    puntoVenta: invoice.ptoVta,
    cbteNro: invoice.cbteNro,
    cbteFecha,
    condicionVenta: 'Contado',
    fechaServicioDesde: invoice.fchServDesde
      ? isoDate(invoice.fchServDesde)
      : null,
    fechaServicioHasta: invoice.fchServHasta
      ? isoDate(invoice.fchServHasta)
      : null,
    fechaVtoPago: cbteFecha,
    items: [
      {
        descripcion: stayDescription(entry),
        cantidad: 1,
        unidadMedida: 'unidades',
        precioUnitario: itemPrice,
        subtotal: itemPrice,
        alicuotaIva: discriminaIva ? rate : null,
      },
    ],
    importeNetoGravado: discriminaIva ? neto : total,
    iva: discriminaIva
      ? [{ descripcion: `${rate}%`, baseImponible: neto, importe: iva }]
      : [],
    importeIva: discriminaIva ? iva : 0,
    importeTotal: total,
    cae: invoice.cae,
    caeFechaVencimiento: isoDate(invoice.caeVto),
    observaciones:
      letter === 'B' && iva > 0
        ? `Régimen de Transparencia Fiscal al Consumidor (Ley 27.743) – IVA contenido: $${ARS.format(iva)}`
        : null,
    qrUrl: arcaQrUrl({
      fecha: cbteFecha,
      cuit: Number(invoice.emisorCuit),
      ptoVta: invoice.ptoVta,
      tipoCmp: invoice.cbteTipo,
      nroCmp: invoice.cbteNro,
      importe: total,
      tipoDocRec: withCuit ? DOC_TIPO_CUIT : DOC_TIPO_SIN_IDENTIFICAR,
      nroDocRec: Number(receptorDocNro) || 0,
      codAut: Number(invoice.cae),
    }),
  };
}

/**
 * El QR de la RG 4892: `https://www.afip.gob.ar/fe/qr/?p=` + el JSON del
 * comprobante en base64, con las claves en este orden.
 *
 * @see https://www.afip.gob.ar/fe/qr/especificaciones.asp
 */
export function arcaQrUrl(input: {
  fecha: string;
  cuit: number;
  ptoVta: number;
  tipoCmp: number;
  nroCmp: number;
  importe: number;
  tipoDocRec: number;
  nroDocRec: number;
  codAut: number;
}): string {
  const payload = {
    ver: 1,
    fecha: input.fecha,
    cuit: input.cuit,
    ptoVta: input.ptoVta,
    tipoCmp: input.tipoCmp,
    nroCmp: input.nroCmp,
    importe: input.importe,
    moneda: 'PES',
    ctz: 1,
    tipoDocRec: input.tipoDocRec,
    nroDocRec: input.nroDocRec,
    tipoCodAut: 'E',
    codAut: input.codAut,
  };
  const base64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `${ARCA_QR_BASE_URL}?p=${base64}`;
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

/** Columna `@db.Date` (00:00 UTC) → `AAAA-MM-DD`. */
function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** `24/09/2026 10:00` en hora argentina (sin la coma de `es-AR`). */
function dateTime(value: Date): string {
  return AR_DATE_TIME.format(value).replace(',', '');
}
