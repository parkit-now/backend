import type { ArcaTaxCondition } from '@prisma/client';

/** Impuestos del padrón que deciden la condición frente al IVA. */
const IMPUESTO_IVA = 30;
const IMPUESTO_IVA_EXENTO = 32;

export interface ArcaFiscalData {
  readonly razonSocial: string | null;
  readonly condicionIva: ArcaTaxCondition | null;
  readonly domicilioFiscal: string | null;
}

interface RawDomicilio {
  direccion?: string;
  localidad?: string;
  descripcionProvincia?: string;
  codPostal?: string;
}

interface RawPersona {
  datosGenerales?: {
    razonSocial?: string;
    nombre?: string;
    apellido?: string;
    domicilioFiscal?: RawDomicilio;
  };
  datosMonotributo?: unknown;
  datosRegimenGeneral?: {
    impuesto?: Array<{ idImpuesto?: number }> | { idImpuesto?: number };
  };
  errorConstancia?: unknown;
}

/**
 * Lee lo que Parkit necesita de la constancia de inscripción
 * (`getTaxpayerDetails`). `null` si ARCA no tiene al contribuyente: el
 * padrón de homologación devuelve `null` para los CUIT reales.
 *
 * `condicionIva` puede quedar en `null` aunque haya datos (un contribuyente
 * sin IVA ni monotributo activos): quien llama decide si eso bloquea.
 */
export function parseTaxpayer(raw: unknown): ArcaFiscalData | null {
  if (!raw || typeof raw !== 'object') return null;
  const persona = raw as RawPersona;
  if (persona.errorConstancia || !persona.datosGenerales) return null;

  const general = persona.datosGenerales;
  const razonSocial =
    general.razonSocial?.trim() ||
    [general.apellido, general.nombre]
      .filter((part) => part?.trim())
      .join(' ')
      .trim() ||
    null;

  return {
    razonSocial,
    condicionIva: resolveCondicion(persona),
    domicilioFiscal: formatDomicilio(general.domicilioFiscal),
  };
}

function resolveCondicion(persona: RawPersona): ArcaTaxCondition | null {
  if (persona.datosMonotributo) return 'monotributo';

  // El SOAP devuelve un objeto suelto cuando hay un solo impuesto.
  const raw = persona.datosRegimenGeneral?.impuesto;
  const impuestos = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const ids = new Set(impuestos.map((i) => i.idImpuesto));
  if (ids.has(IMPUESTO_IVA)) return 'responsable_inscripto';
  if (ids.has(IMPUESTO_IVA_EXENTO)) return 'exento';
  return null;
}

function formatDomicilio(domicilio?: RawDomicilio): string | null {
  if (!domicilio) return null;
  const parts = [
    domicilio.direccion,
    domicilio.localidad,
    domicilio.descripcionProvincia,
  ]
    .map((part) => part?.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}
