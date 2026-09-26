import type { ArcaTaxCondition } from '@prisma/client';

/** Códigos de comprobante de ARCA que emite Parkit. */
export const CbteTipos = { A: 1, B: 6, C: 11 } as const;
export type CbteLetter = keyof typeof CbteTipos;

/** `DocTipo` de ARCA: 80 = CUIT, 99 = consumidor final sin identificar. */
export const DOC_TIPO_CUIT = 80;
const DOC_TIPO_SIN_IDENTIFICAR = 99;

/** `CondicionIVAReceptorId` 5 = Consumidor Final (lista real en la Etapa 0). */
const CONDICION_IVA_CONSUMIDOR_FINAL = 5;

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
   * Receptor identificado con CUIT, ya consultado en el padrón. Sólo cambia
   * algo si el emisor es RI: sale una A. Un monotributista emite C igual.
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
 * Decide el comprobante de una estadía a consumidor final.
 *
 * - Monotributo o Exento → **C**: no discrimina IVA, `ImpNeto = total`.
 * - Responsable Inscripto → **B**: el IVA va discriminado para ARCA.
 * - Responsable Inscripto con receptor → **A** (DocTipo 80), mismo cálculo de
 *   IVA que la B. Quién puede recibir una A lo decide `resolveReceiver`.
 *
 * Homologación NO valida la condición del emisor (aceptó una C de un RI en la
 * Etapa 0), así que esta función es la única garantía de la letra correcta.
 */
export function resolveVoucher(input: ResolveVoucherInput): ResolvedVoucher {
  const totalCents = Math.round(input.total * 100);
  const base = {
    docTipo: DOC_TIPO_SIN_IDENTIFICAR,
    docNro: 0,
    condicionIvaReceptorId: CONDICION_IVA_CONSUMIDOR_FINAL,
    impTotal: totalCents / 100,
  };

  if (input.emitter !== 'responsable_inscripto') {
    return {
      ...base,
      letter: 'C',
      cbteTipo: CbteTipos.C,
      impNeto: totalCents / 100,
      impIva: 0,
    };
  }

  const ivaId = IVA_ID_BY_RATE.get(input.ivaRate);
  if (ivaId === undefined) {
    throw new Error(`Alícuota de IVA no soportada: ${input.ivaRate}%.`);
  }

  // En centavos enteros: neto + iva tiene que dar EXACTO el total, o ARCA
  // rechaza con "ImpTotal no coincide con la suma de los importes".
  const netoCents = Math.round(totalCents / (1 + input.ivaRate / 100));
  const ivaCents = totalCents - netoCents;
  const receiver = input.receiver;

  return {
    ...base,
    ...(receiver
      ? {
          letter: 'A' as const,
          cbteTipo: CbteTipos.A,
          docTipo: DOC_TIPO_CUIT,
          docNro: Number(receiver.cuit),
          condicionIvaReceptorId: receiver.condicionIvaReceptorId,
        }
      : { letter: 'B' as const, cbteTipo: CbteTipos.B }),
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
