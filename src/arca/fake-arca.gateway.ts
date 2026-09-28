import type {
  ArcaCredentials,
  ArcaGateway,
  ArcaVoucherInfo,
  ArcaVoucherRequest,
  ArcaVoucherResult,
} from './arca.gateway';
import { ArcaUnavailableError } from './arca.gateway';

type Outcome = 'approve' | 'reject' | 'timeout' | 'timeout-but-approved';

/**
 * `ArcaGateway` en memoria para los tests: numera por (ptoVta, tipo) como
 * ARCA y deja elegir qué pasa con el próximo `createVoucher`.
 *
 * `timeout-but-approved` es el caso que justifica la reconciliación: la
 * espera se corta pero ARCA sí autorizó el comprobante.
 */
export class FakeArcaGateway implements ArcaGateway {
  readonly vouchers = new Map<string, ArcaVoucherInfo>();
  readonly createCalls: ArcaVoucherRequest[] = [];
  private outcomes: Outcome[] = [];
  private caeCounter = 86380920900000;
  /** Lo que devuelve el padrón (`null` = sin datos, como en homologación). */
  taxpayer: unknown = null;
  /** Error que tira el padrón en vez de responder (ARCA caída). */
  taxpayerError: Error | null = null;
  readonly taxpayerCalls: string[] = [];

  /** Encola resultados para los próximos `createVoucher` (default: aprobar). */
  willRespond(...outcomes: Outcome[]): this {
    this.outcomes.push(...outcomes);
    return this;
  }

  getServerStatus(): Promise<unknown> {
    return Promise.resolve({
      appServer: 'OK',
      dbServer: 'OK',
      authServer: 'OK',
    });
  }

  getIvaReceptorTypes(): Promise<unknown> {
    return Promise.resolve([]);
  }

  getSalesPoints(): Promise<unknown> {
    return Promise.resolve([]);
  }

  getTaxpayerDetails(_creds: ArcaCredentials, cuit: string): Promise<unknown> {
    this.taxpayerCalls.push(cuit);
    if (this.taxpayerError) return Promise.reject(this.taxpayerError);
    return Promise.resolve(this.taxpayer);
  }

  getLastVoucher(
    _creds: ArcaCredentials,
    ptoVta: number,
    cbteTipo: number,
  ): Promise<number> {
    let last = 0;
    for (const key of this.vouchers.keys()) {
      const [p, t, n] = key.split(':').map(Number);
      if (p === ptoVta && t === cbteTipo) last = Math.max(last, n);
    }
    return Promise.resolve(last);
  }

  async createVoucher(
    creds: ArcaCredentials,
    voucher: ArcaVoucherRequest,
  ): Promise<ArcaVoucherResult> {
    this.createCalls.push(voucher);
    const outcome = this.outcomes.shift() ?? 'approve';

    if (outcome === 'reject') {
      return {
        approved: false,
        messages: [{ code: 10016, msg: 'Comprobante rechazado (fake).' }],
        raw: {},
      };
    }

    const expected =
      (await this.getLastVoucher(creds, voucher.PtoVta, voucher.CbteTipo)) + 1;
    if (voucher.CbteDesde !== expected) {
      return {
        approved: false,
        messages: [{ code: 10016, msg: `Se esperaba el número ${expected}.` }],
        raw: {},
      };
    }

    const info: ArcaVoucherInfo = {
      cae: String(++this.caeCounter),
      caeVto: '20261004',
      impTotal: voucher.ImpTotal,
    };
    if (outcome !== 'timeout') {
      this.vouchers.set(
        `${voucher.PtoVta}:${voucher.CbteTipo}:${voucher.CbteDesde}`,
        info,
      );
    }
    if (outcome === 'timeout' || outcome === 'timeout-but-approved') {
      throw new ArcaUnavailableError('ARCA no respondió (fake).', true);
    }
    return { approved: true, ...info, messages: [], raw: {} };
  }

  getVoucherInfo(
    _creds: ArcaCredentials,
    cbteNro: number,
    ptoVta: number,
    cbteTipo: number,
  ): Promise<ArcaVoucherInfo | null> {
    return Promise.resolve(
      this.vouchers.get(`${ptoVta}:${cbteTipo}:${cbteNro}`) ?? null,
    );
  }
}
