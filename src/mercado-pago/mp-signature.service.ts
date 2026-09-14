import { HttpStatus, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { MpConfigService } from './mp-config.service';

/** Ventana de replay: ±5 minutos alrededor del `ts` firmado. */
export const MP_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/** Ruta lógica para el campo `instance` de los ProblemDetails. */
const INSTANCE = '/mercado-pago/webhooks';

/**
 * Por encima de este valor el `ts` se interpreta en milisegundos. Un
 * timestamp en segundos de esta era ronda 1.7e9 y uno en milisegundos 1.7e12,
 * así que el umbral separa ambos casos sin ambigüedad hasta el año 5138.
 */
const MILLISECONDS_THRESHOLD = 1e11;

/** Lo que hace falta para verificar una notificación. */
export interface MpWebhookSignatureInput {
  /** Header `x-signature`, con la forma `ts=<ts>,v1=<hash hex>`. */
  readonly signatureHeader?: string | null;
  /** Header `x-request-id`. Puede no venir. */
  readonly requestId?: string | null;
  /** Query param `data.id` de la notificación. Puede no venir. */
  readonly dataId?: string | null;
  /** Reloj inyectable, para poder testear la ventana de replay. */
  readonly now?: Date;
}

interface ParsedSignature {
  readonly ts: string;
  readonly v1: string;
}

/**
 * Verifica la firma HMAC de los webhooks de Mercado Pago.
 *
 * El manifest se arma exactamente así (y el orden importa):
 *
 * ```
 * manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`
 * v1       = HMAC_SHA256(MP_WEBHOOK_SECRET, manifest).hex()
 * ```
 *
 * Detalles que en la práctica rompen integraciones:
 *
 * - **`data.id` va en minúsculas.** Mercado Pago a veces lo manda en
 *   mayúsculas en la query pero firma la versión en minúsculas.
 * - **Si un dato falta, su segmento se REMUEVE entero** del manifest. No se
 *   deja `id:;` vacío: cambiaría el HMAC y no validaría nunca.
 * - **El `ts` del manifest es el string crudo del header**, no el resultado de
 *   parsearlo y volver a imprimirlo: cualquier normalización (ceros a la
 *   izquierda, segundos vs. milisegundos) cambiaría el hash.
 * - **La comparación es `timingSafeEqual`**, nunca `===`: comparar strings
 *   corta en el primer byte distinto y filtra, por tiempo, cuánto del hash
 *   acertó el atacante. `timingSafeEqual` además tira si los buffers miden
 *   distinto, así que el largo se compara antes (el largo del hash esperado es
 *   siempre 64 caracteres hex: no revela nada).
 * - **Ventana de replay de ±5 minutos**: sin esto, una notificación válida
 *   capturada una vez sirve para siempre.
 *
 * Falta de secreto y firma inválida son casos DISTINTOS: lo primero es un
 * error de configuración nuestro (excepción con code propio, 503, que hace que
 * Mercado Pago reintente más tarde); lo segundo es una notificación que hay que
 * descartar (devuelve `false`).
 */
@Injectable()
export class MpSignatureService {
  constructor(private readonly config: MpConfigService) {}

  /**
   * `true` sólo si la firma corresponde al manifest y el `ts` cae dentro de la
   * ventana. Lanza `FormattedException` si el secreto no está configurado.
   */
  isValid(input: MpWebhookSignatureInput): boolean {
    const secret = this.config.webhookSecret;
    if (!secret) {
      throw new FormattedException(
        'Service Unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
        'MP_WEBHOOK_SECRET is not configured: incoming Mercado Pago ' +
          'notifications cannot be verified yet.',
        INSTANCE,
        ErrorCodes.MP_WEBHOOK_SECRET_NOT_CONFIGURED,
      );
    }

    const parsed = this.parseSignatureHeader(input.signatureHeader);
    if (!parsed) return false;

    if (!this.isWithinWindow(parsed.ts, input.now ?? new Date())) return false;

    const manifest = this.buildManifest(
      parsed.ts,
      input.dataId,
      input.requestId,
    );
    const expected = createHmac('sha256', secret)
      .update(manifest)
      .digest('hex');

    return this.safeEquals(parsed.v1, expected);
  }

  /**
   * Arma el manifest omitiendo los segmentos cuyo dato no llegó, y bajando
   * `data.id` a minúsculas.
   */
  private buildManifest(
    ts: string,
    dataId?: string | null,
    requestId?: string | null,
  ): string {
    const segments: string[] = [];
    if (dataId) segments.push(`id:${dataId.toLowerCase()};`);
    if (requestId) segments.push(`request-id:${requestId};`);
    segments.push(`ts:${ts};`);
    return segments.join('');
  }

  /** Parsea `ts=<ts>,v1=<hash>`. Devuelve `null` si falta o está mal formado. */
  private parseSignatureHeader(header?: string | null): ParsedSignature | null {
    if (!header) return null;

    let ts: string | undefined;
    let v1: string | undefined;

    for (const part of header.split(',')) {
      const separator = part.indexOf('=');
      if (separator <= 0) continue;

      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (!value) continue;

      if (key === 'ts') ts = value;
      else if (key === 'v1') v1 = value;
    }

    if (!ts || !v1) return null;
    return { ts, v1 };
  }

  /**
   * Acepta el `ts` en segundos o en milisegundos: Mercado Pago manda una u
   * otra unidad según la integración, y adivinar mal descarta notificaciones
   * legítimas por millones de años de diferencia.
   */
  private isWithinWindow(ts: string, now: Date): boolean {
    if (!/^\d+$/.test(ts)) return false;

    const value = Number(ts);
    if (!Number.isFinite(value) || value <= 0) return false;

    const signedAt = value > MILLISECONDS_THRESHOLD ? value : value * 1000;
    return Math.abs(now.getTime() - signedAt) <= MP_SIGNATURE_WINDOW_MS;
  }

  /**
   * Comparación en tiempo constante. El chequeo de largo previo evita que
   * `timingSafeEqual` tire con buffers de distinto tamaño: esa excepción, si
   * escapara, sería en sí misma un canal lateral ("tu hash tiene otro largo").
   */
  private safeEquals(received: string, expected: string): boolean {
    const a = Buffer.from(received, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
