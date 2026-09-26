import type { ArcaEnvironment, ArcaTaxCondition } from '@prisma/client';

/**
 * `CondicionIVAReceptorId` de ARCA que usa Parkit (lista real de
 * `FEParamGetCondicionIvaReceptor`, Etapa 0).
 */
export const CondicionIvaReceptor = {
  RESPONSABLE_INSCRIPTO: 1,
  EXENTO: 4,
  CONSUMIDOR_FINAL: 5,
  MONOTRIBUTO: 6,
  MONOTRIBUTO_SOCIAL: 13,
  MONOTRIBUTO_PROMOVIDO: 16,
} as const;

/** Las condiciones con `cmp_Clase` A: las únicas que reciben Factura A. */
const RECEIVES_INVOICE_A: ReadonlySet<number> = new Set([
  CondicionIvaReceptor.RESPONSABLE_INSCRIPTO,
  CondicionIvaReceptor.MONOTRIBUTO,
  CondicionIvaReceptor.MONOTRIBUTO_SOCIAL,
  CondicionIvaReceptor.MONOTRIBUTO_PROMOVIDO,
]);

export function receivesInvoiceA(condicionIvaReceptorId: number): boolean {
  return RECEIVES_INVOICE_A.has(condicionIvaReceptorId);
}

/** Descripción de ARCA de cada condición, para mostrarla al operario. */
const CONDICION_LABELS: Readonly<Record<number, string>> = {
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

export function condicionIvaLabel(condicionIvaReceptorId: number): string {
  return (
    CONDICION_LABELS[condicionIvaReceptorId] ??
    `Condición ${condicionIvaReceptorId}`
  );
}

/**
 * Condición del receptor a partir de lo que leyó `parseTaxpayer`.
 *
 * Sin IVA ni monotributo activos (`null`) es Consumidor Final (5), no «No
 * Categorizado» (7): una persona con CUIT que no está inscripta en ningún
 * impuesto compra como consumidor final; el 7 es para quien debería estar
 * inscripto y no lo está, algo que el padrón no dice.
 */
export function condicionIvaReceptorFor(
  condicionIva: ArcaTaxCondition | null,
): number {
  switch (condicionIva) {
    case 'responsable_inscripto':
      return CondicionIvaReceptor.RESPONSABLE_INSCRIPTO;
    case 'monotributo':
      return CondicionIvaReceptor.MONOTRIBUTO;
    case 'exento':
      return CondicionIvaReceptor.EXENTO;
    default:
      return CondicionIvaReceptor.CONSUMIDOR_FINAL;
  }
}

/** Lo que dijo el padrón de un CUIT (o su caché). */
export interface PadronReceiver {
  readonly razonSocial: string | null;
  /** `null` = ARCA no tiene datos de este CUIT. */
  readonly condicionIvaReceptorId: number | null;
}

export type ReceiverResolution =
  | {
      readonly ok: true;
      readonly condicionIvaReceptorId: number;
      readonly nombre: string;
      /**
       * `true` si ARCA no tenía datos y se tomó como Responsable Inscripto
       * (sólo en homologación, ver `resolveReceiver`).
       */
      readonly assumed: boolean;
    }
  | { readonly ok: false; readonly code: 'INVOICE_RECEIVER_NOT_FOUND' };

/**
 * Decide con qué condición se identifica al receptor en la factura.
 *
 * - Con datos en el padrón → la condición que dice el padrón. Si recibe A o
 *   no lo decide `resolveVoucher` junto con la condición del emisor.
 * - Sin datos → en producción no se puede identificar: la factura va a
 *   consumidor final (el operario lo ve antes de emitir). En homologación el
 *   padrón devuelve `null` para los CUIT reales (igual que al vincular), así
 *   que se toma como Responsable Inscripto para poder probar la A.
 */
export function resolveReceiver(input: {
  readonly cuit: string;
  readonly padron: PadronReceiver | null;
  readonly environment: ArcaEnvironment;
}): ReceiverResolution {
  const { cuit, padron } = input;
  const nombre = padron?.razonSocial ?? `CUIT ${formatCuit(cuit)}`;

  if (padron?.condicionIvaReceptorId != null) {
    return {
      ok: true,
      condicionIvaReceptorId: padron.condicionIvaReceptorId,
      nombre,
      assumed: false,
    };
  }
  return input.environment === 'homologacion'
    ? {
        ok: true,
        condicionIvaReceptorId: CondicionIvaReceptor.RESPONSABLE_INSCRIPTO,
        nombre,
        assumed: true,
      }
    : { ok: false, code: 'INVOICE_RECEIVER_NOT_FOUND' };
}

/** `20123456783` → `20-12345678-3`. */
export function formatCuit(cuit: string): string {
  return `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`;
}
