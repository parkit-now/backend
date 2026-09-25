import type { ArcaEnvironment } from '@prisma/client';

/** Token de inyección: en runtime `ArcaSdkGateway`, en tests `FakeArcaGateway`. */
export const ARCA_GATEWAY = Symbol('ARCA_GATEWAY');

/** Con qué certificado y en nombre de qué CUIT se habla con ARCA. */
export interface ArcaCredentials {
  readonly cuit: string;
  readonly certPem: string;
  /** Clave privada YA descifrada. Nunca se loguea ni se persiste así. */
  readonly keyPem: string;
  readonly certFingerprint: string;
  readonly environment: ArcaEnvironment;
}

/** Lo que se manda a `FECAESolicitar`, con los nombres de ARCA. */
export interface ArcaVoucherRequest {
  readonly PtoVta: number;
  readonly CbteTipo: number;
  readonly Concepto: number;
  readonly DocTipo: number;
  readonly DocNro: number;
  readonly CbteDesde: number;
  readonly CbteHasta: number;
  readonly CbteFch: string;
  readonly FchServDesde?: string;
  readonly FchServHasta?: string;
  readonly FchVtoPago?: string;
  readonly ImpTotal: number;
  readonly ImpTotConc: number;
  readonly ImpNeto: number;
  readonly ImpOpEx: number;
  readonly ImpIVA: number;
  readonly ImpTrib: number;
  readonly MonId: string;
  readonly MonCotiz: number;
  readonly CondicionIVAReceptorId: number;
  readonly Iva?: ReadonlyArray<{
    readonly Id: number;
    readonly BaseImp: number;
    readonly Importe: number;
  }>;
}

export interface ArcaMessage {
  readonly code?: number;
  readonly msg: string;
}

export interface ArcaVoucherResult {
  readonly approved: boolean;
  readonly cae?: string;
  /** `AAAAMMDD`. */
  readonly caeVto?: string;
  /** Observaciones y errores de ARCA, juntos: es lo que se le muestra al dueño. */
  readonly messages: readonly ArcaMessage[];
  /** Respuesta cruda, para `arca_requests`. */
  readonly raw: unknown;
}

export interface ArcaVoucherInfo {
  readonly cae: string;
  /** `AAAAMMDD`. */
  readonly caeVto?: string;
  readonly impTotal?: number;
}

/**
 * Falla al hablar con ARCA: red, timeout, WSAA, servicio caído. `outcomeUnknown`
 * dice si el comprobante PUDO haber llegado (timeout de `createVoucher`): en
 * ese caso no se puede dar por fallido sin consultar antes.
 */
export class ArcaUnavailableError extends Error {
  constructor(
    message: string,
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = 'ArcaUnavailableError';
  }
}

/**
 * Lo único que Parkit necesita de ARCA. Cada implementación resuelve el ticket
 * del WSAA por su cuenta: quien llama sólo pasa las credenciales.
 */
export interface ArcaGateway {
  getServerStatus(creds: ArcaCredentials): Promise<unknown>;
  getIvaReceptorTypes(creds: ArcaCredentials): Promise<unknown>;
  getSalesPoints(creds: ArcaCredentials): Promise<unknown>;
  getTaxpayerDetails(creds: ArcaCredentials, cuit: string): Promise<unknown>;
  /** Último número autorizado (0 si no hay ninguno). */
  getLastVoucher(
    creds: ArcaCredentials,
    ptoVta: number,
    cbteTipo: number,
  ): Promise<number>;
  createVoucher(
    creds: ArcaCredentials,
    voucher: ArcaVoucherRequest,
  ): Promise<ArcaVoucherResult>;
  /** `null` si ARCA no tiene ese comprobante. */
  getVoucherInfo(
    creds: ArcaCredentials,
    cbteNro: number,
    ptoVta: number,
    cbteTipo: number,
  ): Promise<ArcaVoucherInfo | null>;
}
