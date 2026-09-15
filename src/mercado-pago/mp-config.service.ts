import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Base de la API de Mercado Pago cuando `MP_API_BASE_URL` no viene seteada. */
const DEFAULT_API_BASE_URL = 'https://api.mercadopago.com';

/** Largo exacto, en bytes, de una clave AES-256 ya decodificada de base64. */
export const MP_TOKEN_KEY_BYTES = 32;

/** Versión asumida para la clave activa si no se declara explícitamente. */
const DEFAULT_KEY_VERSION = 1;

/** `token_key_version` es `smallint` en la base: ese es el techo real. */
const MAX_KEY_VERSION = 32767;

/** Alfabeto base64 estándar, con padding opcional. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Una clave de cifrado con su número de versión (el que va a la columna). */
export interface MpEncryptionKey {
  readonly version: number;
  readonly key: Buffer;
}

interface MpSettings {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly oauthRedirectUri: string;
  readonly apiBaseUrl: string;
  readonly webhookSecret?: string;
  readonly activeKey: MpEncryptionKey;
  readonly keysByVersion: ReadonlyMap<number, Buffer>;
}

/**
 * Configuración de la integración con Mercado Pago, validada AL BOOT.
 *
 * Todo se resuelve en `onModuleInit`, es decir ANTES de que Nest bindee el
 * puerto: si falta una variable o está mal formada, el proceso muere en el
 * arranque y el deploy falla a la vista de todos. La alternativa —validar en
 * el primer uso— esconde el problema hasta el primer cobro real, que es
 * exactamente el peor momento para enterarse.
 *
 * ## Por qué `MP_WEBHOOK_SECRET` NO es obligatoria
 *
 * Ese secreto todavía no existe: Mercado Pago lo genera recién cuando se
 * registra la URL del webhook en el panel (etapa B4). Exigirlo acá dejaría el
 * backend sin poder levantar por algo que ni siquiera se puede completar aún.
 * Se expone como opcional y es `MpSignatureService` el que falla —con un
 * error propio y distinguible— si alguien intenta verificar una firma sin el
 * secreto cargado.
 *
 * ## Claves de cifrado y rotación
 *
 * `mp_accounts` va a guardar `token_key_version smallint` al lado del token
 * cifrado, así que el servicio tiene que poder descifrar con claves viejas
 * mientras cifra siempre con la activa. La forma más simple que funciona:
 *
 * | Variable                           | Rol                                                      |
 * | ---------------------------------- | -------------------------------------------------------- |
 * | `MP_TOKEN_ENCRYPTION_KEY`          | clave ACTIVA, la que cifra. base64 de 32 bytes            |
 * | `MP_TOKEN_ENCRYPTION_KEY_VERSION`  | versión de la activa (entero 1..32767, default 1)         |
 * | `MP_TOKEN_ENCRYPTION_KEY_PREVIOUS` | claves viejas, SOLO para descifrar: `2:<base64>,1:<b64>`  |
 *
 * Por qué así y no un único JSON con todas las claves: la clave activa queda
 * en su propia variable, sin parsing, y ese es el camino crítico. Las viejas
 * viven en una lista opcional que igual se valida al boot. Los separadores
 * son seguros: el alfabeto base64 estándar (`A-Z a-z 0-9 + / =`) no contiene
 * ni `:` ni `,`.
 *
 * Rotar es entonces: mover la clave actual a `MP_TOKEN_ENCRYPTION_KEY_PREVIOUS`
 * con su número de versión, poner la nueva en `MP_TOKEN_ENCRYPTION_KEY` y
 * subir `MP_TOKEN_ENCRYPTION_KEY_VERSION`. Las filas viejas se siguen
 * leyendo con su versión; las nuevas se escriben con la nueva. No hace falta
 * re-cifrar la tabla en el mismo deploy.
 *
 * Generar una clave: `openssl rand -base64 32`.
 */
@Injectable()
export class MpConfigService implements OnModuleInit {
  private readonly logger = new Logger(MpConfigService.name);

  private settings?: MpSettings;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.settings = this.loadSettings();

    if (!this.settings.webhookSecret) {
      this.logger.warn(
        'MP_WEBHOOK_SECRET no está configurada: la verificación de firma de ' +
          'webhooks va a rechazar todo hasta que se registre la URL en ' +
          'Mercado Pago y se cargue el secreto.',
      );
    }

    this.logger.log(
      `Configuración de Mercado Pago validada (API ${this.settings.apiBaseUrl}, ` +
        `clave de tokens v${this.settings.activeKey.version}, ` +
        `${this.settings.keysByVersion.size - 1} clave(s) anterior(es)).`,
    );
  }

  get clientId(): string {
    return this.requireSettings().clientId;
  }

  get clientSecret(): string {
    return this.requireSettings().clientSecret;
  }

  get oauthRedirectUri(): string {
    return this.requireSettings().oauthRedirectUri;
  }

  /** Sin barra final, para poder concatenar paths sin dobles barras. */
  get apiBaseUrl(): string {
    return this.requireSettings().apiBaseUrl;
  }

  /** `undefined` mientras el webhook no esté registrado en Mercado Pago. */
  get webhookSecret(): string | undefined {
    return this.requireSettings().webhookSecret;
  }

  /** Clave con la que se cifra hoy. Su `version` va a `token_key_version`. */
  get activeEncryptionKey(): MpEncryptionKey {
    return this.requireSettings().activeKey;
  }

  /**
   * Clave para descifrar una fila guardada con `token_key_version = version`.
   * `undefined` si esa versión ya no está declarada en el entorno (nadie
   * debería borrar una clave anterior antes de re-cifrar sus filas).
   */
  encryptionKeyFor(version: number): Buffer | undefined {
    return this.requireSettings().keysByVersion.get(version);
  }

  private requireSettings(): MpSettings {
    if (!this.settings) {
      throw new Error(
        'MpConfigService se usó antes de inicializarse. Tiene que estar ' +
          'provisto por MercadoPagoModule para que Nest corra su onModuleInit.',
      );
    }
    return this.settings;
  }

  private loadSettings(): MpSettings {
    const clientId = this.requireNonEmpty('MP_CLIENT_ID');
    const clientSecret = this.requireNonEmpty('MP_CLIENT_SECRET');
    const oauthRedirectUri = this.parseHttpsUrl(
      'MP_OAUTH_REDIRECT_URI',
      this.requireNonEmpty('MP_OAUTH_REDIRECT_URI'),
    );

    const rawApiBaseUrl =
      this.config.get<string>('MP_API_BASE_URL')?.trim() ||
      DEFAULT_API_BASE_URL;
    const apiBaseUrl = this.parseHttpsUrl(
      'MP_API_BASE_URL',
      rawApiBaseUrl,
    ).replace(/\/+$/, '');

    const activeKey: MpEncryptionKey = {
      version: this.parseKeyVersion(
        'MP_TOKEN_ENCRYPTION_KEY_VERSION',
        this.config.get<string>('MP_TOKEN_ENCRYPTION_KEY_VERSION')?.trim() ||
          String(DEFAULT_KEY_VERSION),
      ),
      key: this.parseKey(
        'MP_TOKEN_ENCRYPTION_KEY',
        this.config.getOrThrow<string>('MP_TOKEN_ENCRYPTION_KEY'),
      ),
    };

    const keysByVersion = this.parsePreviousKeys(activeKey);

    const webhookSecret =
      this.config.get<string>('MP_WEBHOOK_SECRET')?.trim() || undefined;

    return {
      clientId,
      clientSecret,
      oauthRedirectUri,
      apiBaseUrl,
      webhookSecret,
      activeKey,
      keysByVersion,
    };
  }

  /**
   * `getOrThrow` cubre el caso "no está definida"; la cadena vacía sí está
   * definida y pasaría igual, así que se chequea aparte.
   */
  private requireNonEmpty(name: string): string {
    const value = this.config.getOrThrow<string>(name);
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) {
      throw new Error(
        `${name} está vacía. Es obligatoria para operar con Mercado Pago.`,
      );
    }
    return trimmed;
  }

  /**
   * Valida que sea una URL HTTPS y devuelve el valor TAL CUAL vino, sin
   * normalizar: el redirect URI tiene que coincidir carácter por carácter con
   * el registrado en Mercado Pago, y `new URL().toString()` agrega barras
   * finales que romperían esa comparación.
   */
  private parseHttpsUrl(name: string, value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} no es una URL válida (valor: "${value}").`);
    }
    if (url.protocol !== 'https:') {
      throw new Error(
        `${name} debe ser HTTPS (valor: "${value}"). Mercado Pago rechaza ` +
          'redirects y callbacks que no vayan cifrados.',
      );
    }
    return value;
  }

  private parseKeyVersion(name: string, value: string): number {
    const version = Number(value);
    if (
      !Number.isInteger(version) ||
      version < 1 ||
      version > MAX_KEY_VERSION
    ) {
      throw new Error(
        `${name} debe ser un entero entre 1 y ${MAX_KEY_VERSION} ` +
          `(la columna token_key_version es smallint). Valor recibido: "${value}".`,
      );
    }
    return version;
  }

  /** Decodifica una clave base64 y exige que mida exactamente 32 bytes. */
  private parseKey(name: string, value: unknown): Buffer {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) {
      throw new Error(
        `${name} está vacía. Generá una clave con: openssl rand -base64 32`,
      );
    }
    if (!BASE64_PATTERN.test(raw)) {
      throw new Error(
        `${name} no es base64 válido. Generá una clave con: openssl rand -base64 32`,
      );
    }

    const key = Buffer.from(raw, 'base64');
    if (key.length !== MP_TOKEN_KEY_BYTES) {
      throw new Error(
        `${name} debe decodificar a exactamente ${MP_TOKEN_KEY_BYTES} bytes ` +
          `(AES-256) y decodificó a ${key.length}. ` +
          'Generá una clave con: openssl rand -base64 32',
      );
    }
    return key;
  }

  /**
   * Arma el mapa `versión -> clave` con la activa más las declaradas en
   * `MP_TOKEN_ENCRYPTION_KEY_PREVIOUS` (`<versión>:<base64>` separadas por coma).
   */
  private parsePreviousKeys(
    activeKey: MpEncryptionKey,
  ): ReadonlyMap<number, Buffer> {
    const keys = new Map<number, Buffer>([[activeKey.version, activeKey.key]]);

    const raw = this.config
      .get<string>('MP_TOKEN_ENCRYPTION_KEY_PREVIOUS')
      ?.trim();
    if (!raw) return keys;

    for (const entry of raw.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;

      const separator = trimmed.indexOf(':');
      if (separator <= 0) {
        throw new Error(
          'MP_TOKEN_ENCRYPTION_KEY_PREVIOUS mal formada. Se espera ' +
            `"<versión>:<clave base64>" separadas por coma; llegó: "${trimmed}".`,
        );
      }

      const version = this.parseKeyVersion(
        'MP_TOKEN_ENCRYPTION_KEY_PREVIOUS',
        trimmed.slice(0, separator).trim(),
      );
      if (keys.has(version)) {
        throw new Error(
          `MP_TOKEN_ENCRYPTION_KEY_PREVIOUS declara la versión ${version} dos ` +
            'veces (o repite la versión de la clave activa). Cada versión ' +
            'tiene que aparecer una sola vez.',
        );
      }

      keys.set(
        version,
        this.parseKey(
          `MP_TOKEN_ENCRYPTION_KEY_PREVIOUS (versión ${version})`,
          trimmed.slice(separator + 1).trim(),
        ),
      );
    }

    return keys;
  }
}
