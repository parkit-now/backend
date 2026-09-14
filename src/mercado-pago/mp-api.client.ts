import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ErrorCodes, type ErrorCode } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { MpConfigService } from './mp-config.service';

/**
 * Techo de tiempo para CUALQUIER llamada a Mercado Pago.
 *
 * Sin timeout, un socket colgado del otro lado se lleva puesto un worker de
 * Node hasta que el sistema operativo corte — que puede ser un par de minutos.
 * Con el flujo de vinculación encadenando tres llamadas (token, store, pos)
 * detrás de un request HTTP del dueño, eso es un request que nunca contesta.
 *
 * 10s es holgado para una API de pagos y sigue siendo menos que el timeout
 * típico de un balanceador (30-60s), así que el error lo emitimos nosotros —
 * con `code` y con log— y no un 504 anónimo del proxy.
 */
export const MP_HTTP_TIMEOUT_MS = 10_000;

/** Largo máximo del texto de error de MP que dejamos entrar a un log. */
const MAX_LOGGED_ERROR_CHARS = 300;

/**
 * Los dos umbrales para decidir si Mercado Pago "está caído". Van como números
 * y no como `HttpStatus`: el `status` de un `Response` es un `number` crudo, y
 * compararlo contra el enum es justo lo que marca `no-unsafe-enum-comparison`
 * —con razón, porque no hay ninguna garantía de que el número venga del enum.
 */
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_FLOOR = 500;

/**
 * Todo lo que parece un secreto de Mercado Pago y NUNCA puede llegar a un log:
 * access tokens (`APP_USR-...`, `TEST-...`), authorization codes (`TG-...`) y
 * refresh tokens (`TG-...` también).
 */
const SECRET_LIKE_PATTERN = /\b(?:APP_USR|TEST|TG|APP)-[\w-]+/g;

/** Tokens de OAuth tal como los devuelve `POST /oauth/token`. */
export interface MpOauthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** `user_id` del vendedor, ya como string (MP lo manda numérico). */
  readonly mpUserId: string;
  /** `expires_in` ya resuelto a instante absoluto. */
  readonly accessTokenExpiresAt: Date;
}

/** Ubicación del `Store`. MP la usa para impuestos: va completa o no va. */
export interface MpStoreLocation {
  readonly streetName: string;
  readonly streetNumber: string;
  readonly cityName: string;
  readonly stateName: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

export interface MpStoreInput {
  readonly name: string;
  readonly externalId: string;
  readonly location: MpStoreLocation;
}

export interface MpStore {
  readonly id: string;
}

export interface MpPosInput {
  readonly name: string;
  readonly storeId: string;
  readonly externalId: string;
}

export interface MpPos {
  readonly id: string;
  readonly externalId: string | null;
  /** URL de la imagen del QR estático de esta caja. */
  readonly qrImageUrl: string | null;
  /** URL del PDF imprimible con el QR (el cartel del mostrador). */
  readonly qrTemplateDocumentUrl: string | null;
}

/** Identifica una operación para traducir su fallo a un ProblemDetails. */
interface MpOperation {
  /** Qué se estaba haciendo. Va al log y al `detail`, en inglés. */
  readonly label: string;
  /** El `code` del ProblemDetails cuando la operación falla. */
  readonly code: ErrorCode;
  /** El `instance` del ProblemDetails: patrón de ruta, no ruta concreta. */
  readonly instance: string;
}

/**
 * Cliente HTTP de la API de Mercado Pago.
 *
 * ## Por qué `fetch` nativo y no axios / `@nestjs/axios`
 *
 * El repo no tiene HOY ningún cliente HTTP: ni axios, ni `@nestjs/axios`, ni un
 * wrapper propio. Sumar una dependencia para cuatro llamadas es costo puro
 * —bundle, superficie de CVEs, una API más que aprender— cuando Bun ya trae
 * `fetch` con `AbortSignal.timeout()`, que es exactamente lo único que axios
 * daría de valor acá. Si algún día hacen falta interceptores, reintentos con
 * backoff o instrumentación transversal, ese es el momento de discutir axios;
 * no antes.
 *
 * El servicio implementa `OnModuleInit` al estilo de `StorageService`
 * (`src/storage/storage.service.ts:32-47`): la config se resuelve UNA vez, en
 * el boot, y no en cada request.
 *
 * ## Contrato de errores
 *
 * Traduce todo fallo a `FormattedException`, siguiendo el patrón de
 * `StorageService`: destructurar la respuesta, `logger.error(...)` con
 * contexto, y recién ahí tirar. Tres casos:
 *
 * | Qué pasó                                   | Status | Code                  |
 * | ------------------------------------------ | ------ | --------------------- |
 * | No hubo respuesta (red caída, timeout, DNS) | 502    | el de la operación    |
 * | MP contestó 429 / 5xx (está caído)          | 503    | `MP_UNAVAILABLE`      |
 * | MP contestó cualquier otro error (4xx)      | 502    | el de la operación    |
 *
 * El 503 tiene su propio code porque es el único caso donde REINTENTAR tiene
 * sentido: el cliente puede mostrar "Mercado Pago no está disponible, probá en
 * unos minutos" en vez de "falló la vinculación".
 *
 * ## 🔴 Regla de logging, no negociable
 *
 * NUNCA se loguea un `access_token`, un `refresh_token`, un `code` de OAuth ni
 * el `client_secret`. Por eso acá no se loguea NINGÚN request body —sólo método
 * y path— y el body de error de MP pasa sí o sí por `redact()` antes de tocar
 * un logger. Un token en un log es un token filtrado: los logs se exportan, se
 * indexan y los ve más gente que la base.
 */
@Injectable()
export class MpApiClient implements OnModuleInit {
  private readonly logger = new Logger(MpApiClient.name);

  private baseUrl!: string;

  constructor(private readonly config: MpConfigService) {}

  onModuleInit(): void {
    this.baseUrl = this.config.apiBaseUrl;
  }

  /**
   * Canjea el `authorization_code` del callback por el par de tokens.
   *
   * `code_verifier` es el secreto de PKCE guardado en `mp_oauth_states`: sin
   * él, un `code` interceptado no se puede canjear. `redirect_uri` tiene que
   * ser byte a byte el registrado en MP, por eso sale de `MpConfigService` sin
   * normalizar.
   */
  async exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
  ): Promise<MpOauthTokens> {
    const payload = await this.post<Record<string, unknown>>(
      {
        label: 'exchange Mercado Pago authorization code',
        code: ErrorCodes.MP_OAUTH_CODE_EXCHANGE_FAILED,
        instance: '/mercado-pago/oauth/callback',
      },
      '/oauth/token',
      {
        grant_type: 'authorization_code',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.oauthRedirectUri,
        code_verifier: codeVerifier,
      },
    );

    return this.readTokens(payload, {
      label: 'exchange Mercado Pago authorization code',
      code: ErrorCodes.MP_OAUTH_CODE_EXCHANGE_FAILED,
      instance: '/mercado-pago/oauth/callback',
    });
  }

  /**
   * Renueva el access token con el `refresh_token`. MISMO endpoint que el
   * canje, sólo cambia el `grant_type`.
   *
   * Lo consume el cron de refresh (etapa B2c); queda listo acá para que esa
   * etapa no tenga que tocar el cliente.
   */
  async refreshAccessToken(refreshToken: string): Promise<MpOauthTokens> {
    const operation: MpOperation = {
      label: 'refresh Mercado Pago access token',
      code: ErrorCodes.MP_OAUTH_CODE_EXCHANGE_FAILED,
      instance: '/mercado-pago/tokens',
    };

    const payload = await this.post<Record<string, unknown>>(
      operation,
      '/oauth/token',
      {
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: refreshToken,
      },
    );

    return this.readTokens(payload, operation);
  }

  /**
   * Crea el `Store` (sucursal) de la playa en la cuenta del vendedor.
   *
   * El `user_id` va en el PATH, no en el body: así lo documenta MP
   * (`POST /users/{user_id}/stores`).
   */
  async createStore(
    accessToken: string,
    mpUserId: string,
    input: MpStoreInput,
  ): Promise<MpStore> {
    const operation: MpOperation = {
      label: 'create Mercado Pago store',
      code: ErrorCodes.MP_STORE_CREATE_FAILED,
      instance: '/mercado-pago/oauth/callback',
    };

    const payload = await this.post<Record<string, unknown>>(
      operation,
      `/users/${encodeURIComponent(mpUserId)}/stores`,
      {
        name: input.name,
        external_id: input.externalId,
        location: {
          street_name: input.location.streetName,
          street_number: input.location.streetNumber,
          city_name: input.location.cityName,
          state_name: input.location.stateName,
          ...(input.location.latitude !== undefined &&
          input.location.longitude !== undefined
            ? {
                latitude: input.location.latitude,
                longitude: input.location.longitude,
              }
            : {}),
        },
      },
      accessToken,
    );

    const id = readId(payload.id);
    if (!id) {
      throw this.malformed(operation, 'response has no store id');
    }
    return { id };
  }

  /**
   * Crea el `POS` (caja) contra el que se genera el QR de la playa.
   *
   * `operating_mode: 'pdv'` es el modo atendido: hay alguien en el mostrador
   * que cobra. Es el que corresponde a una playa, y MP exige que `config.qr.url`
   * esté AUSENTE en ese modo.
   */
  async createPos(accessToken: string, input: MpPosInput): Promise<MpPos> {
    const operation: MpOperation = {
      label: 'create Mercado Pago POS',
      code: ErrorCodes.MP_POS_CREATE_FAILED,
      instance: '/mercado-pago/oauth/callback',
    };

    const payload = await this.post<Record<string, unknown>>(
      operation,
      '/v2/pos',
      {
        name: input.name,
        store_id: input.storeId,
        external_id: input.externalId,
        config: { qr: { operating_mode: 'pdv' } },
      },
      accessToken,
    );

    return this.readPos(payload, operation);
  }

  /**
   * Relee una caja ya creada para refrescar las URLs del QR. Es lo que usa
   * `resyncPos`: las URLs que devuelve MP son públicas y las regenera, así que
   * la fuente de verdad del QR es MP, no nuestra copia.
   */
  async getPos(accessToken: string, posId: string): Promise<MpPos> {
    const operation: MpOperation = {
      label: 'fetch Mercado Pago POS',
      code: ErrorCodes.MP_POS_CREATE_FAILED,
      instance: '/tenants/:tenantId/mercado-pago/pos/resync',
    };

    const payload = await this.send<Record<string, unknown>>(
      operation,
      'GET',
      `/pos/${encodeURIComponent(posId)}`,
      undefined,
      accessToken,
    );

    return this.readPos(payload, operation);
  }

  private async post<T>(
    operation: MpOperation,
    path: string,
    body: Record<string, unknown>,
    accessToken?: string,
  ): Promise<T> {
    return this.send<T>(operation, 'POST', path, body, accessToken);
  }

  /**
   * El único lugar del cliente que toca la red. Centralizar acá el timeout, el
   * parseo y la traducción de errores es lo que garantiza que ninguna operación
   * futura se olvide de alguno de los tres.
   */
  private async send<T>(
    operation: MpOperation,
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    accessToken?: string,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(MP_HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      // Sin respuesta: DNS, socket cortado, o el AbortSignal del timeout.
      // Se loguea el path (nunca el body: lleva el `code` y el client_secret).
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(
        `Mercado Pago is unreachable: ${method} ${path} failed to ${operation.label}`,
        redact(reason),
      );
      throw new FormattedException(
        'Bad Gateway',
        HttpStatus.BAD_GATEWAY,
        `Could not reach Mercado Pago to ${operation.label}: ${redact(reason)}`,
        operation.instance,
        operation.code,
      );
    }

    const rawBody = await response.text().catch(() => '');

    if (!response.ok) {
      const summary = summarizeError(rawBody);
      this.logger.error(
        `Mercado Pago rejected ${method} ${path} (${response.status}) while trying to ${operation.label}`,
        summary,
      );

      // 429 y 5xx son "MP está caído / saturado": transitorios y reintentables.
      // Cualquier otro 4xx es un problema del request y reintentar no arregla
      // nada, así que va como 502 con el code de la operación.
      const unavailable =
        response.status === HTTP_TOO_MANY_REQUESTS ||
        response.status >= HTTP_SERVER_ERROR_FLOOR;

      throw new FormattedException(
        unavailable ? 'Service Unavailable' : 'Bad Gateway',
        unavailable ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.BAD_GATEWAY,
        `Mercado Pago returned ${response.status} while trying to ${operation.label}: ${summary}`,
        operation.instance,
        unavailable ? ErrorCodes.MP_UNAVAILABLE : operation.code,
      );
    }

    try {
      return JSON.parse(rawBody) as T;
    } catch {
      throw this.malformed(operation, 'response body is not valid JSON');
    }
  }

  /** Lee la respuesta de `/oauth/token` exigiendo todo lo que se persiste. */
  private readTokens(
    payload: Record<string, unknown>,
    operation: MpOperation,
  ): MpOauthTokens {
    const accessToken = str(payload.access_token);
    const refreshToken = str(payload.refresh_token);
    const mpUserId = readId(payload.user_id);
    const expiresIn = num(payload.expires_in);

    // Se valida ANTES de persistir: una cuenta a la que le falte el
    // refresh_token queda muerta al primer vencimiento y nadie se entera hasta
    // que el dueño no puede cobrar. Mejor fallar acá, ruidosamente.
    if (!accessToken || !refreshToken || !mpUserId || expiresIn === null) {
      throw this.malformed(
        operation,
        'response is missing access_token, refresh_token, user_id or expires_in',
      );
    }

    return {
      accessToken,
      refreshToken,
      mpUserId,
      accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  /**
   * Lee una caja y saca de ahí las dos URLs del QR.
   *
   * ⚠️ TODO(Checkpoint 2 · sandbox): confirmar cuál de las dos formas devuelve
   * `POST /v2/pos` en la cuenta real. La documentación oficial de Mercado Pago
   * usa DOS nombres distintos para el mismo objeto según la versión del
   * endpoint, y ambos están verificados en la doc (no inventados):
   *
   *  - `POST /v2/pos` (QR Code / Orders) documenta `qr_response`, con
   *    `{ uuid, image, template_document, template_image, qr_code }`.
   *  - `POST /pos` (Point, versión anterior) documenta `qr`, con
   *    `{ image, template_document, template_image }`.
   *
   * Lo que NO está verificado contra una respuesta real es cuál de las dos
   * llega hoy a `/v2/pos` en MLA. Por eso se leen las dos, `qr_response`
   * primero: si MP unificó, gana la documentada para el endpoint que usamos; si
   * todavía devuelve la forma vieja, igual mapea. La alternativa —elegir una y
   * rezar— deja `qr_image_url` en NULL y al dueño sin cartel, con la
   * vinculación "exitosa".
   *
   * `template_image` (PNG del cartel) existe en las dos formas y NO se guarda:
   * `mp_accounts` tiene dos columnas de QR y el PDF es el que se imprime.
   */
  private readPos(
    payload: Record<string, unknown>,
    operation: MpOperation,
  ): MpPos {
    const id = readId(payload.id);
    if (!id) {
      throw this.malformed(operation, 'response has no POS id');
    }

    const qr = obj(payload.qr_response) ?? obj(payload.qr) ?? {};

    return {
      id,
      externalId: str(payload.external_id),
      qrImageUrl: str(qr.image),
      qrTemplateDocumentUrl: str(qr.template_document),
    };
  }

  /** Respuesta 2xx pero con una forma que no sirve: se trata como fallo. */
  private malformed(
    operation: MpOperation,
    detail: string,
  ): FormattedException {
    this.logger.error(
      `Mercado Pago returned an unusable payload while trying to ${operation.label}: ${detail}`,
    );
    return new FormattedException(
      'Bad Gateway',
      HttpStatus.BAD_GATEWAY,
      `Mercado Pago returned an unusable payload while trying to ${operation.label}: ${detail}`,
      operation.instance,
      operation.code,
    );
  }
}

/**
 * Deja pasar al log sólo texto sin secretos: reemplaza cualquier cosa con
 * pinta de token/código de MP y corta el largo.
 *
 * Es una red, no la defensa principal: la defensa principal es no loguear
 * bodies de request. Pero el body de ERROR lo escribe MP y no controlamos qué
 * mete adentro, así que pasa por acá sí o sí.
 */
function redact(value: string): string {
  const masked = value.replace(SECRET_LIKE_PATTERN, '[REDACTED]');
  return masked.length > MAX_LOGGED_ERROR_CHARS
    ? `${masked.slice(0, MAX_LOGGED_ERROR_CHARS)}…`
    : masked;
}

/**
 * Resume el body de error de MP quedándose SÓLO con los campos descriptivos
 * (`message`, `error`) y nunca con el body entero. Si no parsea como JSON con
 * esa forma, cae al texto crudo redactado y truncado.
 */
function summarizeError(rawBody: string): string {
  if (!rawBody) return 'empty response body';

  try {
    const parsed: unknown = JSON.parse(rawBody);
    const body = obj(parsed);
    if (body) {
      const message = str(body.message) ?? str(body.error);
      if (message) return redact(message);
    }
  } catch {
    // No era JSON: se usa el texto crudo, igual de redactado.
  }

  return redact(rawBody);
}

/** String no vacío, o `null`. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** Número finito, o `null`. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Objeto plano, o `null` (arrays incluidos: un array no es un objeto útil acá). */
function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Identificadores de MP: llegan a veces como número (`"id": 1234567`) y a veces
 * como string (`"store_id": "1234567"`). Se normalizan a string porque así
 * viven en `mp_accounts` — y porque comparar ids como números es cómo se pierde
 * precisión con los ids largos de MP.
 */
function readId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return str(value);
}
