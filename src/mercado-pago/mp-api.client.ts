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
  /**
   * Sucursal a la que pertenece la caja.
   *
   * ⚠️ Mercado Pago manda este campo como STRING (`"store_id": "1234567"`)
   * mientras que el `id` del Store viene como NÚMERO (`"id": 1234567`). Los dos
   * pasan por `readId`, que los normaliza a string: compararlos crudos —uno
   * contra el otro— es comparar `'1234567'` con `1234567` y no coincidir nunca.
   */
  readonly storeId: string | null;
  /** URL de la imagen del QR estático de esta caja. */
  readonly qrImageUrl: string | null;
  /** URL del PDF imprimible con el QR (el cartel del mostrador). */
  readonly qrTemplateDocumentUrl: string | null;
}

/**
 * Un ítem de la orden. Mercado Pago cambió la forma de `items[]` en la API de
 * Orders y conviene tenerlo escrito:
 *
 *  - `currency_id` y `picture_url` YA NO EXISTEN. No los agregues.
 *  - lo que antes era `items[].id` ahora se llama `external_code`.
 *  - `unit_measure` es OBLIGATORIO y tiene tope de 10 caracteres (`'unit'`).
 *  - `unit_price` va como STRING decimal, igual que todos los montos.
 */
export interface MpOrderItemInput {
  /** Obligatorio, máx 150 caracteres. SIN datos personales (ver `MpOrderInput.description`). */
  readonly title: string;
  /** STRING decimal: `'1500.00'`. Mandar `number` es el error clásico acá. */
  readonly unitPrice: string;
  /** Entero. Va como número, no como string: es lo único que NO es string. */
  readonly quantity: number;
  /** Obligatorio, máx 10 caracteres. Para una estadía: `'unit'`. */
  readonly unitMeasure: string;
  /**
   * Nuestro código del ítem. Es el que ANTES se llamaba `items[].id`.
   *
   * 🔴 TOPE DE 30 CARACTERES, y es el más chico de toda la orden — más chico
   * que el `external_reference` de la raíz, que es lo que hace que la trampa
   * sea fácil de pisar. Un UUID con guiones (36) NO entra y sin guiones (32)
   * TAMPOCO: hay que truncar. Ver `itemExternalCode()` en
   * `payment-intents.service.ts`.
   */
  readonly externalCode?: string;
}

/**
 * Todo lo que necesita `POST /v1/orders` para el QR de una playa.
 *
 * ## 🔴 Esta interfaz NO puede tener NADA calculado en el momento
 *
 * Nada de `new Date()`, nada de recomputar el monto de la estadía, nada de
 * `randomUUID()`. TODOS los campos tienen que salir, tal cual, de la fila de
 * `payment_intents` que ya está persistida.
 *
 * El motivo es la estrategia de recuperación: cuando un intent queda en
 * `created` porque `POST /v1/orders` murió por timeout, NO SABEMOS si la orden
 * existe del otro lado. La única forma segura de averiguarlo es re-POSTear con
 * la MISMA `X-Idempotency-Key` — si la orden ya existía, Mercado Pago devuelve
 * la original; si no, la crea. Pero eso funciona sólo si el body es IDÉNTICO:
 * misma key + body distinto es `409 idempotency_key_already_used`, y la
 * recuperación falla justo cuando más se la necesita.
 *
 * Un solo campo que cambie rompe todo. Si el monto se recalcula, un minuto más
 * de estadía cambia `total_amount` y adiós. Si `expiration_time` se deriva de
 * "ahora + 5 minutos" como timestamp, cambia en cada reintento y adiós — por
 * eso es una DURACIÓN relativa y no un instante.
 *
 * Regla práctica: si no podés reconstruir este objeto leyendo una fila de
 * `payment_intents`, está mal armado.
 */
export interface MpOrderInput {
  /**
   * El `payment_intent.id` (UUIDv7). Es OBLIGATORIO para MP, tope de 64
   * caracteres y sólo letras, números, `-` y `_` — un UUID son 36 chars de hex
   * y guiones, así que entra holgado y cumple el charset.
   *
   * 🔴 SIN PII. Mercado Pago lo prohíbe explícitamente. Nada de patentes, ni
   * nombres, ni documentos: el id opaco es justamente lo que hay que mandar.
   */
  readonly externalReference: string;
  /** NUESTRO id de la caja (`mp_accounts.external_pos_id`): ata el cobro a esta playa. */
  readonly externalPosId: string;
  /** STRING decimal: `'1500.00'`. Tiene que coincidir con la suma de los pagos. */
  readonly totalAmount: string;
  /**
   * Va en la RAÍZ de la orden, NO dentro de `items`. Máx 150 caracteres.
   *
   * 🔴 SIN PII, Y ACÁ HAY UNA TRAMPA CONCRETA PARA NOSOTROS. La descripción
   * "natural" sería `Estadía ABC123`, con la patente. LA PATENTE ES UN DATO
   * PERSONAL y Mercado Pago prohíbe explícitamente mandar PII en este campo.
   * Va un texto genérico y fijo, tipo `'Estadía de estacionamiento'`.
   *
   * No lo "mejores" después sumándole la patente, el nombre del cliente, el
   * documento ni la cochera. Si hace falta identificar el cobro, ya está
   * `externalReference`, que es opaco y para eso existe.
   */
  readonly description: string;
  /**
   * DURACIÓN RELATIVA en ISO 8601, NO un timestamp: `'PT5M'`, `'PT30S'`.
   * Mínimo 30 segundos, default de MP 15 minutos.
   *
   * Que sea relativa es lo que la hace estable entre reintentos (ver el
   * docblock de esta interfaz): un instante absoluto cambiaría en cada re-POST
   * y rompería la idempotencia.
   */
  readonly expirationTime: string;
  /** Al menos uno. Ver `MpOrderItemInput` por los campos que MP renombró o borró. */
  readonly items: readonly MpOrderItemInput[];
}

/** Una `Order` de Mercado Pago tal como nos interesa persistirla. */
export interface MpOrder {
  readonly id: string;
  /**
   * `created` | `processed` | `canceled` | `refunded` | `expired`. Crudo, sin
   * traducir: se guarda en `payment_intents.mp_status` para diagnóstico. El
   * estado que manda el comportamiento es el NUESTRO.
   */
  readonly status: string | null;
  /**
   * `created` | `canceled` | `accredited` | `refunded` | `expired` |
   * `partially_refunded`. Crudo también, a `payment_intents.mp_status_detail`.
   */
  readonly statusDetail: string | null;
  /** Debería volver igual al que mandamos: sirve para detectar un cruce de órdenes. */
  readonly externalReference: string | null;
  /**
   * `last_updated_date` de la orden, ya parseado. Es el instante en el que MP
   * la movió al `status` que estamos leyendo — y por eso es lo que se guarda en
   * `payment_intents.approved_at` cuando llega `processed`.
   *
   * Nuestro reloj NO sirve para eso: entre que el cliente paga y el webhook nos
   * llega puede haber minutos (reintentos de MP, un deploy nuestro, el
   * reconciliador corriendo horas después), y el comprobante tiene que decir
   * cuándo se pagó, no cuándo nos enteramos. Es además ESTABLE: releer la orden
   * dos veces da el mismo valor, mientras que `new Date()` escribiría uno
   * distinto en cada pasada.
   *
   * `null` si no vino o no parsea: es un campo de conveniencia, nunca una
   * precondición. Quien lo use cae a su propio reloj.
   */
  readonly lastUpdatedDate: Date | null;
}

/** Identifica una operación para traducir su fallo a un ProblemDetails. */
interface MpOperation {
  /** Qué se estaba haciendo. Va al log y al `detail`, en inglés. */
  readonly label: string;
  /**
   * El `code` del ProblemDetails cuando MERCADO PAGO RECHAZÓ el request (4xx).
   * Sólo ese caso: los otros tres —sin respuesta, 429/5xx, 2xx inservible—
   * llevan codes transversales, porque lo que los distingue no es qué
   * operación era sino si el recurso existe del otro lado. Ver la tabla de la
   * cabecera de la clase.
   */
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
 * contexto, y recién ahí tirar. Cuatro casos:
 *
 * | Qué pasó                                   | Status | Code                    |
 * | ------------------------------------------ | ------ | ----------------------- |
 * | No hubo respuesta (red caída, timeout, DNS) | 502    | `MP_UNREACHABLE`        |
 * | MP contestó 429 / 5xx (está caído)          | 503    | `MP_UNAVAILABLE`        |
 * | MP contestó cualquier otro error (4xx)      | 502    | el de la operación      |
 * | MP contestó 2xx con un cuerpo inservible    | 502    | `MP_MALFORMED_RESPONSE` |
 *
 * ## 🔴 Por qué los tres codes transversales y no sólo el de la operación
 *
 * Porque la columna "¿EXISTE EL RECURSO DEL OTRO LADO?" NO es la misma en las
 * cuatro filas, y quien llama necesita esa respuesta para decidir:
 *
 *  - 4xx → NO existe. Mercado Pago leyó el request y lo rechazó.
 *  - 429/5xx y sin respuesta → NO SABEMOS. El POST pudo haber llegado igual y
 *    haberse ejecutado; lo que se perdió fue la respuesta.
 *  - 2xx inservible → SÍ EXISTE, y lo que perdimos es cómo nombrarlo.
 *
 * Eso es exactamente lo que separa, en `PaymentIntentsService.create`, un
 * intento de cobro que queda recuperable en `created` de uno terminal en
 * `failed`. Y `failed` libera `payment_intents_tenant_live_idx`: marcarlo
 * cuando la orden pudo haber quedado viva sobre el QR estático de la caja
 * termina con el cliente del auto siguiente pagando el monto del anterior.
 *
 * Antes de esto, la rama del `catch` del `fetch` y la rama `!response.ok`
 * no-unavailable tiraban EL MISMO `502` + el mismo code, y lo único que
 * cambiaba era el texto en inglés del `detail`. Una máquina de estados que
 * decide sobre plata no puede leer un string de prosa: el discriminador tiene
 * que ser el `code`, que es typesafe contra el catálogo y es el campo que el
 * contrato de errores del repo declara estable.
 *
 * Son codes TRANSVERSALES (uno para TODAS las operaciones) y no uno por
 * operación (`MP_ORDER_CREATE_UNREACHABLE`, `MP_STORE_CREATE_UNREACHABLE`, …)
 * porque el hecho que describen —"no llegamos a Mercado Pago"— es idéntico en
 * todas, `send` es UN solo lugar, y multiplicarlos por operación agregaría seis
 * entradas al catálogo (y a los `CODE_MESSAGES` de los tres frontends) para
 * decir seis veces lo mismo. Qué operación era ya viaja en el `detail` y en el
 * log, que es donde sirve.
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
   *
   * ## 🔴 `city_name` y `state_name` se validan contra un catálogo QUE MP NO
   * ## PUBLICA, y ahí no hay tope que respetar: hay que manejar el rechazo
   *
   * Es la falla de producción que abrió esta serie. MP no documenta ningún
   * largo máximo para los cuatro campos de `location` —los busqué: no
   * existen—, pero sí documenta que los cruza entre sí:
   * `400 VALIDATION_ERROR` con detalle `location.state_name was invalid`
   * significa "esa ciudad no pertenece a esa provincia". La lista de valores
   * buenos NO está publicada en ningún lado, así que NO se puede validar antes
   * de llamar: es una caja negra y lo único honesto es que el rechazo llegue al
   * dueño con el texto de MP (hoy sale como `MP_STORE_CREATE_FAILED`).
   *
   * MP también documenta —en la tabla de errores, no en la de parámetros—
   * `INVALID_NAME`, `INVALID_CITY_NAME`, `INVALID_STATE_NAME` e
   * `INVALID_STREET_NAME` como "sin números ni caracteres especiales". No lo
   * saneamos, y es deliberado: esa prosa se contradice con los propios
   * ejemplos de MP (su POS de muestra se llama `POS-001`), y recortarle los
   * dígitos a "Playa 24hs" le rompería el nombre al dueño para prevenir un
   * error que hoy no ocurre. Si algún día aparece, este es el comentario que
   * dice dónde mirar.
   *
   * ## Topes verificados
   *
   * `external_id` tiene tope de 60 y charset alfanumérico (el nuestro son 43,
   * ver `storeExternalId()`). El `name` NO tiene tope documentado — por eso
   * `storeName()` usa el 45 del POS como cota conservadora. `street_number` va
   * como STRING y no como número (`INVALID_STREET_NUMBER`).
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
   * Busca la sucursal de la playa por su `external_id`. Es la mitad "find" del
   * find-or-create de `MpAccountsService.provision()`.
   *
   * ## Por qué existe
   *
   * Nuestros `external_id` son DETERMINÍSTICOS: salen del `tenant_id`, así que
   * la misma playa pide SIEMPRE el mismo Store. Eso los hace idempotentes por
   * diseño, pero Mercado Pago no lo trata así: si el recurso ya existe contesta
   * `400 external id '...' is already assigned to this user`. Sin esta
   * búsqueda, un intento de vinculación que crea el Store y después muere
   * creando el POS deja el Store HUÉRFANO —vivo en la cuenta de MP, sin que
   * nosotros tengamos su id, porque el flujo no persiste nada si falla— y cada
   * reintento posterior choca contra ese mismo muro. Para siempre.
   *
   * ## ⚠️ `results`, no `data`
   *
   * Este endpoint devuelve los resultados en `results`; el de cajas
   * (`findPosByExternalId`) los devuelve en `data`. Son dos APIs distintas de
   * MP, no un typo. Confundirlas da "no encontré nada" SIEMPRE, que es el peor
   * fallo posible acá: silencioso y que reproduce el bug original.
   *
   * ## No encontrar nada NO es un error
   *
   * Devuelve `null`, no tira: "no existe" es la mitad NORMAL del find-or-create
   * (es lo que pasa en toda vinculación primera). Los fallos de verdad —MP
   * caído, token vencido, respuesta ilegible— sí salen por `send()`.
   */
  async findStoreByExternalId(
    accessToken: string,
    mpUserId: string,
    externalId: string,
  ): Promise<MpStore | null> {
    const operation: MpOperation = {
      label: 'search Mercado Pago store by external id',
      code: ErrorCodes.MP_STORE_CREATE_FAILED,
      instance: '/mercado-pago/oauth/callback',
    };

    const payload = await this.send<Record<string, unknown>>(
      operation,
      'GET',
      `/users/${encodeURIComponent(mpUserId)}/stores/search` +
        `?external_id=${encodeURIComponent(externalId)}`,
      undefined,
      accessToken,
    );

    const match = matchByExternalId(payload.results, externalId);
    if (!match) return null;

    const id = readId(match.id);
    if (!id) {
      // Encontramos la sucursal pero no podemos nombrarla: crear tampoco va a
      // andar (MP la va a rechazar por `external_id` repetido), así que el
      // camino honesto es cortar acá con el code que dice justamente eso.
      throw this.malformed(operation, 'store search result has no store id');
    }
    return { id };
  }

  /**
   * Crea el `POS` (caja) contra el que se genera el QR de la playa.
   *
   * `operating_mode: 'pdv'` es el modo atendido: hay alguien en el mostrador
   * que cobra. Es el que corresponde a una playa, y MP exige que `config.qr.url`
   * esté AUSENTE en ese modo.
   *
   * ## 🔴 `X-Idempotency-Key`: `POST /v2/pos` LA EXIGE
   *
   * No es una mejora opcional: sin el header MP contesta
   * `400 {"message":"Missing X-Idempotency-Key header","code":"bad_request"}` y
   * la caja no se crea NUNCA. Está en la doc oficial de QR y en la de Point, en
   * las dos, y en producción salió como un `502 MP_POS_CREATE_FAILED`.
   *
   * ⚠️ El Store NO la lleva: `POST /users/{id}/stores` no la documenta y MP
   * acepta el alta sin ella. La asimetría es de Mercado Pago, no un olvido
   * nuestro — ver `createStore`.
   *
   * ## La recibe, no la inventa
   *
   * Mismo reparto de responsabilidades que `createOrder`: la key llega YA
   * ARMADA desde `MpAccountsService.provision()`, que la deriva como un hash
   * DETERMINÍSTICO del body de este alta. Un `randomUUID()` acá convertiría
   * cada reintento en una caja nueva, que es justo el problema de recursos
   * huérfanos que resolvió el find-or-create.
   *
   * 🔴 Por eso `input` y la key tienen que describir LO MISMO. Si algún día se
   * le suma un campo al body que no salga de `input` —un literal nuevo acá
   * adentro, digamos—, el service no lo puede ver y la key deja de distinguir
   * dos altas distintas: reaparece el `409 idempotency_key_already_used` que la
   * huella del body vino a eliminar. Todo lo que varíe va en `MpPosInput`.
   *
   * ## Topes de la caja, verificados contra la referencia
   *
   * | Campo                | Tope MP                                        |
   * | -------------------- | ---------------------------------------------- |
   * | `X-Idempotency-Key`  | 1 a 64 (el más chico de toda la API)           |
   * | `name`               | 45; `[A-Za-z0-9 _-]`, sin espacio al principio ni al final |
   * | `external_id`        | 40; SÓLO alfanumérico, único por usuario       |
   * | `store_id`           | 20; sólo dígitos, y va como STRING             |
   * | `config.qr.url`      | 200; AUSENTE con `operating_mode: 'pdv'`       |
   *
   * ⚠️ El charset del `name` y el del `external_id` NO son el mismo: el `name`
   * acepta guiones y guiones bajos, el `external_id` no acepta ninguno de los
   * dos. Por eso `posExternalId()` y `posName()` son dos funciones distintas.
   *
   * ⚠️ `fixed_amount` y `category` en la raíz YA NO EXISTEN en `/v2/pos` (eran
   * del `POST /pos` v1, que hoy ni está documentado). `category` vive ahora en
   * `config.qr.category`, y no la mandamos.
   */
  async createPos(
    accessToken: string,
    input: MpPosInput,
    idempotencyKey: string,
  ): Promise<MpPos> {
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
      idempotencyKey,
    );

    return this.readPos(payload, operation);
  }

  /**
   * Busca la caja de la playa por su `external_id`. Gemela de
   * `findStoreByExternalId`, con dos diferencias que hay que tener presentes.
   *
   * ## ⚠️ 1) Acá los resultados vienen en `data`, no en `results`
   *
   * `GET /users/{id}/stores/search` → `{ results: [...] }`
   * `GET /v2/pos`                   → `{ data: [...] }`
   *
   * La asimetría es de Mercado Pago y está verificada contra la referencia
   * oficial. Leer la clave equivocada devuelve `null` siempre.
   *
   * ## 🔴 2) El `qr_response` viene en la búsqueda igual que en la creación
   *
   * Por eso la respuesta pasa por el MISMO `readPos()` que `createPos()`: una
   * caja adoptada tiene que traer `image` y `template_document` igual que una
   * recién creada. Si se adopta el POS y se pierde el QR, la vinculación queda
   * "exitosa" y el dueño no puede imprimir el cartel del mostrador —que es lo
   * único que hace cobrable la playa.
   *
   * No encontrar nada devuelve `null`, no tira. Ver el docblock de la gemela.
   */
  async findPosByExternalId(
    accessToken: string,
    externalId: string,
  ): Promise<MpPos | null> {
    const operation: MpOperation = {
      label: 'search Mercado Pago POS by external id',
      code: ErrorCodes.MP_POS_CREATE_FAILED,
      instance: '/mercado-pago/oauth/callback',
    };

    const payload = await this.send<Record<string, unknown>>(
      operation,
      'GET',
      `/v2/pos?external_id=${encodeURIComponent(externalId)}`,
      undefined,
      accessToken,
    );

    const match = matchByExternalId(payload.data, externalId);
    return match ? this.readPos(match, operation) : null;
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

  /**
   * Crea la `Order` contra la que el cliente va a pagar escaneando el QR.
   *
   * ## `config.qr.mode: 'static'` — la decisión más fácil de romper de acá
   *
   * `mode` tiene TRES valores: `static` (el QR está impreso y asociado a la
   * caja — EL NUESTRO), `dynamic` (un QR único por transacción) y `hybrid`
   * (los dos). `static` es además el default de MP, pero se manda EXPLÍCITO
   * igual: un default puede cambiar, y este campo decide si el cartel que ya
   * imprimimos sirve o no.
   *
   * ⚠️ La guía de migración desde la API legacy de QR menciona SÓLO `dynamic` y
   * `hybrid`. Si alguien la lee y "corrige" esto, el PDF del QR que generamos
   * al vincular la cuenta (etapa B2b) queda inservible y nadie se entera hasta
   * que un cliente escanea el cartel y no pasa nada.
   *
   * ## Los tres detalles del contrato que más se equivocan
   *
   * 1. LOS MONTOS VAN COMO STRING DECIMAL (`'1500.00'`), no como número. Aplica
   *    a `total_amount`, a `transactions.payments[].amount` y a
   *    `items[].unit_price`. Mandar `number` es el error clásico.
   * 2. `notification_url` NO EXISTE en el body de Orders. El webhook se
   *    configura a nivel APLICACIÓN (tópico "Order (Mercado Pago)"), en el
   *    panel de MP. Mandarlo acá no hace nada bueno.
   * 3. UNA SOLA transacción de pago por orden. `transactions.payments` es un
   *    array porque el modelo lo permite en otros flujos, no porque acá se
   *    pueda mandar más de uno.
   *
   * `processing_mode: 'automatic'` es el único valor válido para QR.
   *
   * ⚠️ TODO(sandbox): confirmar si `processing_mode` CORRESPONDE en el request.
   * En el spec de `POST /v1/orders` para `type: 'qr'` el campo figura sólo en
   * el `200`/`201`, NO entre los doce campos del `requestBody` (ahí sí está
   * para `type: 'online'`). O sea que podríamos estar mandando una propiedad de
   * respuesta, y MP documenta un `400 unsupported_properties` para eso. HOY NO
   * PASA: el 400 que nos comimos en producción nombró SÓLO el `external_code`,
   * así que MP lo está tolerando. No se saca a ciegas porque sacarlo cambia el
   * body y eso toca la recuperación idempotente (ver el docblock de
   * `MpOrderInput`): se prueba contra sandbox primero.
   *
   * ## Topes de los campos de la orden, verificados contra la referencia
   *
   * Los números están en la PROSA de cada parámetro, nunca en el schema —el
   * spec de MP no tiene un solo `maxLength`—, así que hay que leerla entera:
   *
   * | Campo                  | Tope MP                          |
   * | ---------------------- | -------------------------------- |
   * | `external_reference`   | 64, charset `[A-Za-z0-9_-]`      |
   * | `description`          | 150                              |
   * | `items[]`              | 10 elementos                     |
   * | `items[].title`        | 150                              |
   * | `items[].unit_measure` | 10 (texto libre, en minúsculas)  |
   * | `items[].external_code`| 30  ← el más chico de todos      |
   * | `expiration_time`      | PT30S a 3600h (default PT15M)    |
   * | `transactions.payments`| 1 transacción                    |
   *
   * Sin tope documentado (NO inferir uno): `config.qr.external_pos_id` —el
   * techo real es el 40 del `external_id` de la caja, que es otro endpoint—,
   * `X-Idempotency-Key` y los dígitos de los montos.
   *
   * ⚠️ El `items[].unit_price` de 18 caracteres que documenta MP es de
   * `type: 'online'`. NO aplica acá y no hay que copiarlo por analogía.
   *
   * ## `X-Idempotency-Key`: la recibe, no la inventa
   *
   * La key llega YA ARMADA desde el service, que la deriva de forma
   * DETERMINÍSTICA del `payment_intent.id` y la namespacea por operación
   * (`create:` / `cancel:`). Determinística porque es lo que permite reintentar
   * el mismo POST y recuperar la orden original en vez de duplicarla; y
   * namespaceada porque cancelar es una SOLICITUD DISTINTA: reusar la key del
   * create para el cancel da `409 idempotency_key_already_used` (la ventana de
   * la key es de 24 h).
   *
   * Si el cliente la generara por su cuenta —con un `randomUUID()`, digamos—
   * cada reintento sería una orden nueva y el doble cobro dejaría de ser un
   * riesgo teórico.
   *
   * 🔴 El body tiene que ser RECONSTRUIBLE BYTE A BYTE desde la fila de
   * `payment_intents`. Ver el docblock de `MpOrderInput`: misma key + body
   * distinto es 409, y ahí se rompe la recuperación de un intent en `created`.
   * Por eso este método arma el objeto siempre en el MISMO orden de claves y no
   * calcula NADA: todo sale de `input`.
   */
  async createOrder(
    accessToken: string,
    input: MpOrderInput,
    idempotencyKey: string,
  ): Promise<MpOrder> {
    const operation: MpOperation = {
      label: 'create Mercado Pago order',
      code: ErrorCodes.MP_ORDER_CREATE_FAILED,
      instance: '/tenants/:tenantId/payment-intents',
    };

    const payload = await this.post<Record<string, unknown>>(
      operation,
      '/v1/orders',
      {
        type: 'qr',
        processing_mode: 'automatic',
        external_reference: input.externalReference,
        description: input.description,
        expiration_time: input.expirationTime,
        total_amount: input.totalAmount,
        config: {
          qr: {
            external_pos_id: input.externalPosId,
            mode: 'static',
          },
        },
        transactions: {
          payments: [{ amount: input.totalAmount }],
        },
        items: input.items.map((item) => ({
          title: item.title,
          unit_price: item.unitPrice,
          quantity: item.quantity,
          unit_measure: item.unitMeasure,
          ...(item.externalCode === undefined
            ? {}
            : { external_code: item.externalCode }),
        })),
      },
      accessToken,
      idempotencyKey,
    );

    return this.readOrder(payload, operation);
  }

  /**
   * Relee una orden. Es lo que usa el poller del modal de cobro y lo que usa el
   * reconciliador para resolver un intent del que no llegó webhook.
   *
   * NO lleva `X-Idempotency-Key`, y no es un olvido: los GET no la llevan. Un
   * GET no crea nada, así que no hay nada que deduplicar — y mandar la key del
   * create en un GET sólo sirve para quemarla.
   */
  async getOrder(accessToken: string, orderId: string): Promise<MpOrder> {
    const operation: MpOperation = {
      label: 'fetch Mercado Pago order',
      code: ErrorCodes.MP_ORDER_CREATE_FAILED,
      instance: '/tenants/:tenantId/payment-intents/:paymentIntentId',
    };

    const payload = await this.send<Record<string, unknown>>(
      operation,
      'GET',
      `/v1/orders/${encodeURIComponent(orderId)}`,
      undefined,
      accessToken,
    );

    return this.readOrder(payload, operation);
  }

  /**
   * Cancela una orden que todavía no se pagó: lo que pasa cuando el operador
   * cierra el modal o cuando vence el intent.
   *
   * SÍ lleva `X-Idempotency-Key`, igual que la creación (las dos de Orders;
   * afuera de Orders la lleva `createPos`). Y tiene que ser una key DISTINTA de
   * la del create del mismo intent — de ahí el namespace `cancel:` que arma el
   * service. Reusar la del create devuelve `409 idempotency_key_already_used`
   * porque el body no coincide, no la orden cancelada.
   */
  async cancelOrder(
    accessToken: string,
    orderId: string,
    idempotencyKey: string,
  ): Promise<MpOrder> {
    const operation: MpOperation = {
      label: 'cancel Mercado Pago order',
      code: ErrorCodes.MP_ORDER_CREATE_FAILED,
      instance: '/tenants/:tenantId/payment-intents/:paymentIntentId/cancel',
    };

    const payload = await this.post<Record<string, unknown>>(
      operation,
      `/v1/orders/${encodeURIComponent(orderId)}/cancel`,
      {},
      accessToken,
      idempotencyKey,
    );

    return this.readOrder(payload, operation);
  }

  private async post<T>(
    operation: MpOperation,
    path: string,
    body: Record<string, unknown>,
    accessToken?: string,
    idempotencyKey?: string,
  ): Promise<T> {
    return this.send<T>(
      operation,
      'POST',
      path,
      body,
      accessToken,
      idempotencyKey,
    );
  }

  /**
   * El único lugar del cliente que toca la red. Centralizar acá el timeout, el
   * parseo y la traducción de errores es lo que garantiza que ninguna operación
   * futura se olvide de alguno de los tres.
   *
   * `idempotencyKey` se sumó para la API de Orders, que exige
   * `X-Idempotency-Key` en la creación y la cancelación, y lo usa también el
   * alta del POS (`POST /v2/pos` la exige igual). Sigue siendo OPCIONAL acá
   * porque hay endpoints que no la llevan —los GET, y el alta del Store—, no
   * porque sea decorativa. Es un parámetro NOMBRADO, no una bolsa genérica de
   * headers, a propósito: una bolsa deja que cualquiera pise el `Authorization`
   * o el `Content-Type` desde afuera, y de paso esconde qué headers manda
   * realmente el cliente. Si algún día hace falta un segundo header, se suma
   * otro parámetro igual de explícito.
   */
  private async send<T>(
    operation: MpOperation,
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    accessToken?: string,
    idempotencyKey?: string,
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
          ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
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
      // 🔴 `MP_UNREACHABLE` y NO `operation.code`: acá NO SABEMOS si el request
      // llegó. Un POST que murió esperando la respuesta pudo haberse ejecutado
      // igual del otro lado. Quien llama tiene que poder distinguir esto de un
      // rechazo 4xx sin leer el `detail` — ver la tabla de la cabecera.
      throw new FormattedException(
        'Bad Gateway',
        HttpStatus.BAD_GATEWAY,
        `Could not reach Mercado Pago to ${operation.label}: ${redact(reason)}`,
        operation.instance,
        ErrorCodes.MP_UNREACHABLE,
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
      // `store_id` llega como string y el `id` del Store como número: los dos
      // pasan por `readId` para que se puedan comparar entre sí.
      storeId: readId(payload.store_id),
      qrImageUrl: str(qr.image),
      qrTemplateDocumentUrl: str(qr.template_document),
    };
  }

  /**
   * Lee una `Order` quedándose con lo único que se persiste: el id y el par de
   * estados crudos.
   *
   * El `id` es lo ÚNICO que se exige. Sin él no hay a qué volver a preguntarle
   * a MP ni con qué atar el webhook a la fila, así que una respuesta sin id es
   * inservible aunque haya llegado con 201. `status` y `status_detail` se dejan
   * pasar en NULL porque son para diagnóstico: faltar no rompe nada.
   */
  private readOrder(
    payload: Record<string, unknown>,
    operation: MpOperation,
  ): MpOrder {
    const id = readId(payload.id);
    if (!id) {
      throw this.malformed(operation, 'response has no order id');
    }

    return {
      id,
      status: str(payload.status),
      statusDetail: str(payload.status_detail),
      externalReference: str(payload.external_reference),
      lastUpdatedDate: date(payload.last_updated_date),
    };
  }

  /**
   * Respuesta 2xx pero con una forma que no sirve: se trata como fallo.
   *
   * Lleva `MP_MALFORMED_RESPONSE` y NO el code de la operación porque acá
   * Mercado Pago SÍ ejecutó lo que le pedimos —contestó 2xx— y lo que se perdió
   * es el identificador. Es lo contrario de un rechazo: el recurso existe. Para
   * un `POST /v1/orders` eso significa una orden viva sobre el QR de la caja
   * que no podemos nombrar, y la única forma de recuperar su id es re-POSTear
   * con la misma `X-Idempotency-Key` — que es justamente lo que deja de pasar
   * si el intento se marca `failed`.
   */
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
      ErrorCodes.MP_MALFORMED_RESPONSE,
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

/**
 * Fecha ISO 8601 de Mercado Pago, o `null` si falta o es impresentable.
 *
 * El chequeo de `NaN` no es paranoia: `new Date('cualquier cosa')` NO tira,
 * devuelve un `Invalid Date` que se persiste feliz y recién explota al
 * serializarlo. Un campo de diagnóstico no puede romper nada.
 */
function date(value: unknown): Date | null {
  const raw = str(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * De la lista que devuelve una búsqueda, el ítem cuyo `external_id` coincide
 * EXACTO.
 *
 * 🔴 Exacto, y no "el primero del array", a propósito. Mercado Pago NO
 * documenta si el filtro `?external_id=` matchea exacto o por prefijo, y un
 * mismo vendedor puede tener varias playas nuestras en la misma cuenta
 * (`PARKITSTORE<uuid-A>`, `PARKITSTORE<uuid-B>`). Si MP algún día devuelve de
 * más, quedarse con el primero significa adoptar la sucursal de OTRA playa: el
 * QR de una terminaría colgado de la caja de la otra. Ante la duda NO se
 * adopta, se crea — y si crear falla, el error de MP lo dice y queda auditado.
 */
function matchByExternalId(
  value: unknown,
  externalId: string,
): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;

  for (const item of value) {
    const row = obj(item);
    if (row && str(row.external_id) === externalId) return row;
  }
  return null;
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
