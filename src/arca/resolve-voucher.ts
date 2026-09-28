import type { ArcaTaxCondition } from '@prisma/client';
import { CondicionIvaReceptor, receivesInvoiceA } from './invoice-receiver';

/** Códigos de comprobante de ARCA que emite Parkit. */
export const CbteTipos = { A: 1, B: 6, C: 11 } as const;
export type CbteLetter = keyof typeof CbteTipos;

/** `DocTipo` de ARCA: 80 = CUIT, 99 = consumidor final sin identificar. */
export const DOC_TIPO_CUIT = 80;
const DOC_TIPO_SIN_IDENTIFICAR = 99;

/**
 * Id de alícuota de ARCA (`FEParamGetTiposIva`) por porcentaje. Un porcentaje
 * que no esté acá es un error de configuración, no se redondea al más cercano.
 */
const IVA_ID_BY_RATE: ReadonlyMap<number, number> = new Map([
  [0, 3],
  [2.5, 9],
  [5, 8],
  [10.5, 4],
  [21, 5],
  [27, 6],
]);

export interface ResolveVoucherInput {
  /** Condición del EMISOR (la playa). */
  readonly emitter: ArcaTaxCondition;
  /** Total cobrado, IVA incluido. */
  readonly total: number;
  /** Alícuota de la playa en porcentaje (21 = 21%). Se ignora en la C. */
  readonly ivaRate: number;
  /**
   * Receptor identificado con CUIT, con la condición que dio el padrón
   * (`resolveReceiver`). Sin él, la factura es a consumidor final.
   */
  readonly receiver?: {
    readonly cuit: string;
    readonly condicionIvaReceptorId: number;
  };
}

export interface ResolvedVoucher {
  readonly letter: CbteLetter;
  readonly cbteTipo: number;
  readonly docTipo: number;
  readonly docNro: number;
  readonly condicionIvaReceptorId: number;
  readonly impTotal: number;
  readonly impNeto: number;
  readonly impIva: number;
  /** `undefined` en la C: ARCA la rechaza si trae el array. */
  readonly iva?: ReadonlyArray<{
    readonly Id: number;
    readonly BaseImp: number;
    readonly Importe: number;
  }>;
}

/**
 * La letra del comprobante: la decide la condición del EMISOR y, si es RI, la
 * del receptor.
 *
 * - Monotributo o Exento → siempre **C**, aunque el receptor dé su CUIT.
 * - Responsable Inscripto + receptor RI o monotributista (1, 6, 13, 16) → **A**.
 * - Responsable Inscripto + cualquier otro receptor, o sin receptor → **B**.
 *
 * Homologación NO valida la condición del emisor (aceptó una C de un RI en la
 * Etapa 0), así que esta función es la única garantía de la letra correcta.
 */
export function letterFor(
  emitter: ArcaTaxCondition,
  condicionIvaReceptorId: number | null,
): CbteLetter {
  if (emitter !== 'responsable_inscripto') return 'C';
  return condicionIvaReceptorId !== null &&
    receivesInvoiceA(condicionIvaReceptorId)
    ? 'A'
    : 'B';
}

/**
 * Arma el comprobante de una estadía (letra en `letterFor`).
 *
 * - Con receptor: DocTipo 80 (CUIT) y la condición del padrón, en cualquier
 *   letra: una B a un exento o una C con CUIT también lo identifican.
 * - Sin receptor: consumidor final (DocTipo 99, condición 5).
 * - C: no discrimina IVA, `ImpNeto = total`. A y B: IVA discriminado para
 *   ARCA, con el mismo cálculo.
 */
export function resolveVoucher(input: ResolveVoucherInput): ResolvedVoucher {
  const totalCents = Math.round(input.total * 100);
  const receiver = input.receiver;
  const letter = letterFor(
    input.emitter,
    receiver?.condicionIvaReceptorId ?? null,
  );
  const base = {
    letter,
    cbteTipo: CbteTipos[letter],
    ...(receiver
      ? {
          docTipo: DOC_TIPO_CUIT,
          docNro: Number(receiver.cuit),
          condicionIvaReceptorId: receiver.condicionIvaReceptorId,
        }
      : {
          docTipo: DOC_TIPO_SIN_IDENTIFICAR,
          docNro: 0,
          condicionIvaReceptorId: CondicionIvaReceptor.CONSUMIDOR_FINAL,
        }),
    impTotal: totalCents / 100,
  };

  if (letter === 'C') {
    return { ...base, impNeto: totalCents / 100, impIva: 0 };
  }

  const ivaId = IVA_ID_BY_RATE.get(input.ivaRate);
  if (ivaId === undefined) {
    throw new Error(`Alícuota de IVA no soportada: ${input.ivaRate}%.`);
  }

  // En centavos enteros: neto + iva tiene que dar EXACTO el total, o ARCA
  // rechaza con "ImpTotal no coincide con la suma de los importes".
  const netoCents = Math.round(totalCents / (1 + input.ivaRate / 100));
  const ivaCents = totalCents - netoCents;

  return {
    ...base,
    impNeto: netoCents / 100,
    impIva: ivaCents / 100,
    iva: [{ Id: ivaId, BaseImp: netoCents / 100, Importe: ivaCents / 100 }],
  };
}

/** Letra a partir del código de ARCA, para mostrar. */
export function letterForCbteTipo(cbteTipo: number): CbteLetter | null {
  const entry = Object.entries(CbteTipos).find(([, code]) => code === cbteTipo);
  return entry ? (entry[0] as CbteLetter) : null;
}
