import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MpConfigService } from './mp-config.service';

/** Claves de 32 bytes deterministas: lo que importa es el largo, no el valor. */
const KEY_V1 = Buffer.alloc(32, 1).toString('base64');
const KEY_V2 = Buffer.alloc(32, 2).toString('base64');

const BASE_ENV: Record<string, string> = {
  MP_CLIENT_ID: '1234567890',
  MP_CLIENT_SECRET: 'un-secreto',
  MP_OAUTH_REDIRECT_URI: 'https://api.parkit.app/mercado-pago/oauth/callback',
  MP_TOKEN_ENCRYPTION_KEY: KEY_V2,
};

/**
 * `ConfigService` de mentira sobre un objeto plano: `getOrThrow` revienta si la
 * variable no está, igual que el real.
 */
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

/** Construye el servicio y corre el boot, que es donde vive la validación. */
function boot(
  overrides: Record<string, string | undefined> = {},
): MpConfigService {
  const env = { ...BASE_ENV };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  const service = new MpConfigService(fakeConfigService(env));
  service.onModuleInit();
  return service;
}

describe('MpConfigService', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('carga las obligatorias y aplica los defaults', () => {
    const config = boot();

    expect(config.clientId).toBe('1234567890');
    expect(config.clientSecret).toBe('un-secreto');
    expect(config.oauthRedirectUri).toBe(
      'https://api.parkit.app/mercado-pago/oauth/callback',
    );
    expect(config.apiBaseUrl).toBe('https://api.mercadopago.com');
    expect(config.activeEncryptionKey.version).toBe(1);
    expect(config.activeEncryptionKey.key).toHaveLength(32);
  });

  it('MP_WEBHOOK_SECRET ausente NO rompe el boot: recién existe en B4', () => {
    const config = boot({ MP_WEBHOOK_SECRET: undefined });

    expect(config.webhookSecret).toBeUndefined();
  });

  it('toma MP_WEBHOOK_SECRET cuando está', () => {
    expect(boot({ MP_WEBHOOK_SECRET: 'firma-secreta' }).webhookSecret).toBe(
      'firma-secreta',
    );
  });

  it('falla al boot si falta MP_CLIENT_ID', () => {
    expect(() => boot({ MP_CLIENT_ID: undefined })).toThrow(/MP_CLIENT_ID/);
  });

  it('falla al boot si MP_CLIENT_SECRET viene vacía', () => {
    expect(() => boot({ MP_CLIENT_SECRET: '   ' })).toThrow(/MP_CLIENT_SECRET/);
  });

  it('falla al boot si el redirect URI no es HTTPS', () => {
    expect(() =>
      boot({ MP_OAUTH_REDIRECT_URI: 'http://api.parkit.app/callback' }),
    ).toThrow(/HTTPS/);
  });

  it('falla al boot si el redirect URI no es una URL', () => {
    expect(() => boot({ MP_OAUTH_REDIRECT_URI: 'no-soy-una-url' })).toThrow(
      /MP_OAUTH_REDIRECT_URI/,
    );
  });

  it('no normaliza el redirect URI: tiene que matchear al registrado en MP', () => {
    const uri = 'https://api.parkit.app';

    expect(boot({ MP_OAUTH_REDIRECT_URI: uri }).oauthRedirectUri).toBe(uri);
  });

  it('acepta un MP_API_BASE_URL propio y le saca la barra final', () => {
    expect(boot({ MP_API_BASE_URL: 'https://mp.mock.local/' }).apiBaseUrl).toBe(
      'https://mp.mock.local',
    );
  });

  it('expone las claves anteriores por versión, además de la activa', () => {
    const config = boot({
      MP_TOKEN_ENCRYPTION_KEY: KEY_V2,
      MP_TOKEN_ENCRYPTION_KEY_VERSION: '2',
      MP_TOKEN_ENCRYPTION_KEY_PREVIOUS: `1:${KEY_V1}`,
    });

    expect(config.activeEncryptionKey.version).toBe(2);
    expect(config.encryptionKeyFor(2)).toEqual(Buffer.from(KEY_V2, 'base64'));
    expect(config.encryptionKeyFor(1)).toEqual(Buffer.from(KEY_V1, 'base64'));
    expect(config.encryptionKeyFor(3)).toBeUndefined();
  });

  it('rechaza una versión repetida en MP_TOKEN_ENCRYPTION_KEY_PREVIOUS', () => {
    expect(() =>
      boot({ MP_TOKEN_ENCRYPTION_KEY_PREVIOUS: `1:${KEY_V1}` }),
    ).toThrow(/versión 1 dos veces/);
  });

  it('rechaza MP_TOKEN_ENCRYPTION_KEY_PREVIOUS mal formada', () => {
    expect(() => boot({ MP_TOKEN_ENCRYPTION_KEY_PREVIOUS: KEY_V1 })).toThrow(
      /mal formada/,
    );
  });

  it('rechaza una versión fuera del rango de smallint', () => {
    expect(() => boot({ MP_TOKEN_ENCRYPTION_KEY_VERSION: '40000' })).toThrow(
      /smallint/,
    );
  });

  it('usarlo antes del onModuleInit falla fuerte, no devuelve basura', () => {
    const service = new MpConfigService(fakeConfigService(BASE_ENV));

    expect(() => service.clientId).toThrow(/antes de inicializarse/);
  });
});
