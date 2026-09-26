import type { ArcaEnvironment } from '@prisma/client';
import type { ArcaFiscalData } from './arca-padron';

/** `CondicionIVAReceptorId` de ARCA para los receptores de una Factura A. */
const CONDICION_IVA_RECEPTOR = {
  responsable_inscripto: 1,
  monotributo: 6,
} as const;

export type ReceiverResolution =
  | {
      readonly ok: true;
      readonly condicionIvaReceptorId: number;
      readonly nombre: string;
    }
  | {
      readonly ok: false;
      readonly code: 'INVOICE_RECEIVER_NOT_FOUND' | 'INVOICE_RECEIVER_NOT_A';
    };

/**
 * Decide si el CUIT que dio el cliente puede recibir una Factura A, a partir
 * de lo que devolvió el padrón (`parseTaxpayer`).
 *
 * - Responsable Inscripto → condición 1; Monotributista → condición 6.
 * - Otra condición (exento, sin IVA) → no recibe A: el operario emite una B.
 * - Sin datos en el padrón → en producción no se emite. En homologación el
 *   padrón devuelve `null` para los CUIT reales (igual que al vincular), así
 *   que se toma como Responsable Inscripto para poder probar la A.
 */
export function resolveReceiver(input: {
  readonly cuit: string;
  readonly fiscal: ArcaFiscalData | null;
  readonly environment: ArcaEnvironment;
}): ReceiverResolution {
  const { cuit, fiscal } = input;
  const nombre =
    fiscal?.razonSocial ??
    `CUIT ${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`;

  if (!fiscal) {
    return input.environment === 'homologacion'
      ? {
          ok: true,
          condicionIvaReceptorId: CONDICION_IVA_RECEPTOR.responsable_inscripto,
          nombre,
        }
      : { ok: false, code: 'INVOICE_RECEIVER_NOT_FOUND' };
  }

  if (
    fiscal.condicionIva === 'responsable_inscripto' ||
    fiscal.condicionIva === 'monotributo'
  ) {
    return {
      ok: true,
      condicionIvaReceptorId: CONDICION_IVA_RECEPTOR[fiscal.condicionIva],
      nombre,
    };
  }
  return { ok: false, code: 'INVOICE_RECEIVER_NOT_A' };
}
