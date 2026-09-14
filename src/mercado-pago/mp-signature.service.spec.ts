import { HttpStatus } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { MpConfigService } from './mp-config.service';
import { MpSignatureService } from './mp-signature.service';

const SECRET = 'secreto-del-webhook';
const NOW = new Date('2026-09-13T12:00:00.000Z');
const TS = String(Math.floor(NOW.getTime() / 1000));
const DATA_ID = 'abc-123';
const REQUEST_ID = 'req-1';

/**
 * Los manifests de los tests se escriben a mano, carácter por carácter, en vez
 * de reusar el armador del servicio: si el servicio arma mal el manifest, el
 * test tiene que verlo, no repetir el mismo error.
 */
function hmac(manifest: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(manifest).digest('hex');
}

function header(ts: string, v1: string): string {
  return `ts=${ts},v1=${v1}`;
}

function makeService(secret: string = SECRET): MpSignatureService {
  return new MpSignatureService({
    webhookSecret: secret,
  } as unknown as MpConfigService);
}

/**
 * "Sin secreto" necesita su propio helper: un parámetro con valor por defecto
 * también se dispara cuando le pasás `undefined` explícito, o sea que
 * `makeService(undefined)` devolvería un servicio CON secreto.
 */
function makeServiceSinSecreto(): MpSignatureService {
  return new MpSignatureService({
    webhookSecret: undefined,
  } as unknown as MpConfigService);
}

function problem(error: unknown): { status: number; code: string } {
  return (error as FormattedException).getResponse() as {
    status: number;
    code: string;
  };
}

function capture(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('MpSignatureService', () => {
  it('acepta una firma válida', () => {
    const v1 = hmac(`id:${DATA_ID};request-id:${REQUEST_ID};ts:${TS};`);

    expect(
      makeService().isValid({
        signatureHeader: header(TS, v1),
        requestId: REQUEST_ID,
        dataId: DATA_ID,
        now: NOW,
      }),
    ).toBe(true);
  });

  it('rechaza una firma alterada', () => {
    const v1 = hmac(`id:${DATA_ID};request-id:${REQUEST_ID};ts:${TS};`);
    const alterada = `${v1.slice(0, -1)}${v1.endsWith('a') ? 'b' : 'a'}`;

    expect(
      makeService().isValid({
        signatureHeader: header(TS, alterada),
        requestId: REQUEST_ID,
        dataId: DATA_ID,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('rechaza una firma hecha con otro secreto', () => {
    const v1 = hmac(
      `id:${DATA_ID};request-id:${REQUEST_ID};ts:${TS};`,
      'otro-secreto',
    );

    expect(
      makeService().isValid({
        signatureHeader: header(TS, v1),
        requestId: REQUEST_ID,
        dataId: DATA_ID,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('data.id en MAYÚSCULAS valida igual: se baja a minúsculas', () => {
    // MP firma el id en minúsculas pero a veces lo manda en mayúsculas.
    const v1 = hmac(`id:${DATA_ID};request-id:${REQUEST_ID};ts:${TS};`);

    expect(
      makeService().isValid({
        signatureHeader: header(TS, v1),
        requestId: REQUEST_ID,
        dataId: DATA_ID.toUpperCase(),
        now: NOW,
      }),
    ).toBe(true);
  });

  it('no valida si el manifest se firmó con el data.id en mayúsculas', () => {
    const v1 = hmac(
      `id:${DATA_ID.toUpperCase()};request-id:${REQUEST_ID};ts:${TS};`,
    );

    expect(
      makeService().isValid({
        signatureHeader: header(TS, v1),
        requestId: REQUEST_ID,
        dataId: DATA_ID.toUpperCase(),
        now: NOW,
      }),
    ).toBe(false);
  });

  it('sin data.id el segmento id se REMUEVE del manifest', () => {
    const v1 = hmac(`request-id:${REQUEST_ID};ts:${TS};`);

    expect(
      makeService().isValid({
        signatureHeader: header(TS, v1),
        requestId: REQUEST_ID,
        now: NOW,
      }),
    ).toBe(true);
  });

  it('sin data.id NO se firma un segmento id vacío', () => {
    const v1 = hmac(`id:;request-id:${REQUEST_ID};ts:${TS};`);

    expect(
      makeService().isValid({
        signatureHeader: header(TS, v1),
        requestId: REQUEST_ID,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('sin x-request-id el segmento request-id se REMUEVE del manifest', () => {
    const v1 = hmac(`id:${DATA_ID};ts:${TS};`);

    expect(
      makeService().isValid({
        signatureHeader: header(TS, v1),
        dataId: DATA_ID,
        now: NOW,
      }),
    ).toBe(true);
  });

  it('rechaza un ts viejo, fuera de la ventana de replay', () => {
    const viejo = String(Number(TS) - 6 * 60);
    const v1 = hmac(`id:${DATA_ID};request-id:${REQUEST_ID};ts:${viejo};`);

    expect(
      makeService().isValid({
        signatureHeader: header(viejo, v1),
        requestId: REQUEST_ID,
        dataId: DATA_ID,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('rechaza un ts futuro, fuera de la ventana de replay', () => {
    const futuro = String(Number(TS) + 6 * 60);
    const v1 = hmac(`id:${DATA_ID};request-id:${REQUEST_ID};ts:${futuro};`);

    expect(
      makeService().isValid({
        signatureHeader: header(futuro, v1),
        requestId: REQUEST_ID,
        dataId: DATA_ID,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('acepta el borde de la ventana (4:59 de atraso)', () => {
    const borde = String(Number(TS) - (5 * 60 - 1));
    const v1 = hmac(`id:${DATA_ID};request-id:${REQUEST_ID};ts:${borde};`);

    expect(
      makeService().isValid({
        signatureHeader: header(borde, v1),
        requestId: REQUEST_ID,
        dataId: DATA_ID,
        now: NOW,
      }),
    ).toBe(true);
  });

  it('acepta el ts en milisegundos: MP manda una u otra unidad', () => {
    const ms = String(NOW.getTime());
    const v1 = hmac(`id:${DATA_ID};request-id:${REQUEST_ID};ts:${ms};`);

    expect(
      makeService().isValid({
        signatureHeader: header(ms, v1),
        requestId: REQUEST_ID,
        dataId: DATA_ID,
        now: NOW,
      }),
    ).toBe(true);
  });

  it('rechaza un x-signature ausente o malformado', () => {
    const service = makeService();
    const malformados = [
      undefined,
      null,
      '',
      'cualquier-cosa',
      `ts=${TS}`,
      'v1=deadbeef',
      `ts=,v1=`,
      `ts=no-es-un-numero,v1=${hmac(`ts:no-es-un-numero;`)}`,
    ];

    for (const signatureHeader of malformados) {
      expect(
        service.isValid({ signatureHeader, dataId: DATA_ID, now: NOW }),
      ).toBe(false);
    }
  });

  it('sin secreto configurado tira error explícito, distinto de "firma inválida"', () => {
    const v1 = hmac(`id:${DATA_ID};request-id:${REQUEST_ID};ts:${TS};`);

    const error = capture(() =>
      makeServiceSinSecreto().isValid({
        signatureHeader: header(TS, v1),
        requestId: REQUEST_ID,
        dataId: DATA_ID,
        now: NOW,
      }),
    );

    expect(error).toBeInstanceOf(FormattedException);
    expect(problem(error).code).toBe(
      ErrorCodes.MP_WEBHOOK_SECRET_NOT_CONFIGURED,
    );
    expect(problem(error).status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('sin secreto tira aunque el header sea basura: no lo confunde con firma inválida', () => {
    const error = capture(() =>
      makeServiceSinSecreto().isValid({ signatureHeader: 'basura', now: NOW }),
    );

    expect(problem(error).code).toBe(
      ErrorCodes.MP_WEBHOOK_SECRET_NOT_CONFIGURED,
    );
  });
});
