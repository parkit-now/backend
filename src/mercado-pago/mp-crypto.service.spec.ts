import { HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { MpConfigService } from './mp-config.service';
import { MpCryptoService } from './mp-crypto.service';

/** Claves de 32 bytes deterministas, una por versión. */
const KEY_V1 = Buffer.alloc(32, 1).toString('base64');
const KEY_V2 = Buffer.alloc(32, 2).toString('base64');

/** Un access token de Mercado Pago tiene esta pinta (y este largo). */
const TOKEN =
  'APP_USR-1234567890123456-091312-abcdef0123456789abcdef0123456789-987654321';

const BASE_ENV: Record<string, string> = {
  MP_CLIENT_ID: '1234567890',
  MP_CLIENT_SECRET: 'un-secreto',
  MP_OAUTH_REDIRECT_URI:
    'https://panel.parkit.app/integraciones/mercadopago/callback',
  MP_TOKEN_ENCRYPTION_KEY: KEY_V1,
};

function fakeConfigService(env: Record<string, string>): ConfigService {
  return {
    get: (key: string): string | undefined => env[key],
    getOrThrow: (key: string): string => {
      const value = env[key];
      if (value === undefined) {
        throw new Error(`Configuration key "${key}" does not exist`);
      }
      return value;
    },
  } as unknown as ConfigService;
}

function bootConfig(
  overrides: Record<string, string | undefined> = {},
): MpConfigService {
  const env = { ...BASE_ENV };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  const config = new MpConfigService(fakeConfigService(env));
  config.onModuleInit();
  return config;
}

function makeService(
  overrides: Record<string, string | undefined> = {},
): MpCryptoService {
  return new MpCryptoService(bootConfig(overrides));
}

/**
 * `FormattedException` mete title/status/detail/instance/code en el BODY de la
 * HttpException, no como propiedades de la instancia.
 */
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

/** Da vuelta todos los bits del byte `offset` del payload ya cifrado. */
function flipByte(payload: string, offset: number): string {
  const raw = Buffer.from(payload, 'base64');
  raw[offset] ^= 0xff;
  return raw.toString('base64');
}

const IV_OFFSET = 0;
const TAG_OFFSET = 12;
const CIPHERTEXT_OFFSET = 28;

describe('MpCryptoService', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('round trip: lo que cifra es exactamente lo que descifra', () => {
    const service = makeService();

    const { ciphertext, keyVersion } = service.encrypt(TOKEN);

    expect(ciphertext).not.toContain(TOKEN);
    expect(keyVersion).toBe(1);
    expect(service.decrypt(ciphertext, keyVersion)).toBe(TOKEN);
  });

  it('el formato es base64(iv[12] || tag[16] || ciphertext)', () => {
    const service = makeService();

    const raw = Buffer.from(service.encrypt(TOKEN).ciphertext, 'base64');

    // GCM no expande el plaintext: el overhead son exactamente iv + tag.
    expect(raw).toHaveLength(CIPHERTEXT_OFFSET + Buffer.byteLength(TOKEN));
  });

  /**
   * El invariante más barato de todos y el que más habría servido: 28 bytes de
   * overhead (iv 12 + tag 16) son 40 caracteres en base64 ANTES de meter un
   * solo byte de texto, así que NADA que salga de `encrypt` puede medir menos.
   *
   * Existe porque ya pasó al revés: una fila sembrada a mano con "tokens" de 31
   * caracteres —que no eran ciphertext de nada— entró a la base sin chistar y
   * recién explotó en `decrypt()`, lejos del error. Un largo mínimo distingue
   * un valor cifrado de cualquier string que alguien pegó ahí.
   */
  it('el ciphertext nunca mide menos de 40 caracteres (iv + tag ya son 28 bytes)', () => {
    const service = makeService();

    // Hasta el plaintext más corto posible arrastra el overhead completo.
    expect(service.encrypt('x').ciphertext.length).toBeGreaterThanOrEqual(40);
    expect(service.encrypt(TOKEN).ciphertext.length).toBeGreaterThanOrEqual(40);
  });

  it('dos cifrados del mismo texto dan ciphertexts distintos (IV aleatorio)', () => {
    const service = makeService();

    const primero = service.encrypt(TOKEN).ciphertext;
    const segundo = service.encrypt(TOKEN).ciphertext;

    expect(primero).not.toBe(segundo);
    expect(
      Buffer.from(primero, 'base64').subarray(IV_OFFSET, TAG_OFFSET),
    ).not.toEqual(
      Buffer.from(segundo, 'base64').subarray(IV_OFFSET, TAG_OFFSET),
    );
    // Y aun así los dos descifran al mismo original.
    expect(service.decrypt(primero, 1)).toBe(TOKEN);
    expect(service.decrypt(segundo, 1)).toBe(TOKEN);
  });

  it('adulterar el tag GCM hace fallar el descifrado, no devuelve basura', () => {
    const service = makeService();
    const { ciphertext } = service.encrypt(TOKEN);

    const error = capture(() =>
      service.decrypt(flipByte(ciphertext, TAG_OFFSET), 1),
    );

    expect(error).toBeInstanceOf(FormattedException);
    expect(problem(error).code).toBe(ErrorCodes.MP_TOKEN_DECRYPT_FAILED);
    expect(problem(error).status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it('adulterar el ciphertext hace fallar el descifrado', () => {
    const service = makeService();
    const { ciphertext } = service.encrypt(TOKEN);

    const error = capture(() =>
      service.decrypt(flipByte(ciphertext, CIPHERTEXT_OFFSET), 1),
    );

    expect(error).toBeInstanceOf(FormattedException);
    expect(problem(error).code).toBe(ErrorCodes.MP_TOKEN_DECRYPT_FAILED);
  });

  it('un payload truncado falla en vez de romper por offsets', () => {
    const service = makeService();

    const error = capture(() => service.decrypt('c2FyasA=', 1));

    expect(problem(error).code).toBe(ErrorCodes.MP_TOKEN_DECRYPT_FAILED);
  });

  it('descifra con una key_version anterior y cifra siempre con la activa', () => {
    // Escenario real de rotación: la fila vieja quedó con token_key_version=1
    // y la clave activa ya es la 2.
    const viejo = makeService().encrypt(TOKEN);
    expect(viejo.keyVersion).toBe(1);

    const rotado = makeService({
      MP_TOKEN_ENCRYPTION_KEY: KEY_V2,
      MP_TOKEN_ENCRYPTION_KEY_VERSION: '2',
      MP_TOKEN_ENCRYPTION_KEY_PREVIOUS: `1:${KEY_V1}`,
    });

    expect(rotado.decrypt(viejo.ciphertext, viejo.keyVersion)).toBe(TOKEN);
    expect(rotado.encrypt(TOKEN).keyVersion).toBe(2);
  });

  it('una key_version que el entorno no conoce tiene su propio code', () => {
    const service = makeService();
    const { ciphertext } = service.encrypt(TOKEN);

    const error = capture(() => service.decrypt(ciphertext, 9));

    expect(problem(error).code).toBe(ErrorCodes.MP_TOKEN_KEY_VERSION_UNKNOWN);
  });

  it('clave ausente: error al boot, no en el primer cobro', () => {
    expect(() => makeService({ MP_TOKEN_ENCRYPTION_KEY: undefined })).toThrow(
      /MP_TOKEN_ENCRYPTION_KEY/,
    );
  });

  it('clave de largo incorrecto: error al boot', () => {
    const corta = Buffer.alloc(16, 1).toString('base64');

    expect(() => makeService({ MP_TOKEN_ENCRYPTION_KEY: corta })).toThrow(
      /32 bytes/,
    );
  });

  it('clave que no es base64: error al boot', () => {
    expect(() =>
      makeService({ MP_TOKEN_ENCRYPTION_KEY: 'no es base64 ni a palos!!' }),
    ).toThrow(/base64/);
  });
});
