import { HttpStatus, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { MpApiClient } from './mp-api.client';
import { MpConfigService } from './mp-config.service';

/** Un access token con la pinta real de los de Mercado Pago. */
const TOKEN = 'APP_USR-1234567890-091234-abcdef0123456789-446566691';
const CLIENT_SECRET = 'super-secreto-que-no-puede-loguearse';

describe('MpApiClient', () => {
  let client: MpApiClient;
  let logged: string[];

  // Sin anotar el tipo: `jest.Mock` como TIPO no resuelve acá (los globals
  // vienen de Bun) y anotarlo degrada el mock a `any`.
  const fetchMock = jest.fn();

  const mockConfig = {
    clientId: 'app-id',
    clientSecret: CLIENT_SECRET,
    oauthRedirectUri:
      'https://panel.parkit.test/integraciones/mercadopago/callback',
    apiBaseUrl: 'https://api.mercadopago.com',
  };

  const respond = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
    }) as Response;

  const bodyOf = (): Record<string, unknown> => {
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    return JSON.parse(init.body) as Record<string, unknown>;
  };

  const problemOf = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(FormattedException);
      return (error as FormattedException).getResponse();
    }
    throw new Error('La promesa resolvió y tenía que fallar');
  };

  const createPos = () =>
    client.createPos('token', { name: 'POS', storeId: '1', externalId: 'EXT' });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MpApiClient,
        { provide: MpConfigService, useValue: mockConfig },
      ],
    }).compile();

    client = module.get<MpApiClient>(MpApiClient);
    client.onModuleInit();
    jest.clearAllMocks();

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    logged = [];
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => String(a)).join(' | '));
      });
  });

  it('canjea el código: normaliza el user_id y resuelve expires_in', async () => {
    fetchMock.mockResolvedValue(
      respond(200, {
        access_token: TOKEN,
        refresh_token: 'TG-refresh',
        user_id: 446566691,
        expires_in: 15552000,
      }),
    );
    const before = Date.now();

    const tokens = await client.exchangeAuthorizationCode(
      'TG-code',
      'el-verifier',
    );

    expect(tokens.accessToken).toBe(TOKEN);
    // `user_id` llega numérico: se normaliza a string porque así vive en la
    // columna, y comparar ids largos como números pierde precisión.
    expect(tokens.mpUserId).toBe('446566691');
    expect(tokens.accessTokenExpiresAt.getTime()).toBeGreaterThanOrEqual(
      before + 15552000 * 1000,
    );
    expect(bodyOf().code_verifier).toBe('el-verifier');
    // Byte a byte el registrado en MP: normalizarlo rompe el canje.
    expect(bodyOf().redirect_uri).toBe(mockConfig.oauthRedirectUri);
  });

  it('falla con 502 si la respuesta no trae refresh_token', async () => {
    // Una cuenta sin refresh_token queda muerta al primer vencimiento, y nadie
    // se entera hasta que el dueño no puede cobrar.
    fetchMock.mockResolvedValue(
      respond(200, { access_token: 'a', user_id: 1, expires_in: 10 }),
    );

    expect(
      await problemOf(client.exchangeAuthorizationCode('c', 'v')),
    ).toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      code: ErrorCodes.MP_OAUTH_CODE_EXCHANGE_FAILED,
    });
  });

  it('un fallo de red (o el timeout) da 502 con el code de la operación', async () => {
    fetchMock.mockRejectedValue(new Error('The operation timed out.'));

    expect(await problemOf(createPos())).toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      code: ErrorCodes.MP_POS_CREATE_FAILED,
    });
  });

  it('un 4xx da 502 con el code de la operación', async () => {
    fetchMock.mockResolvedValue(respond(400, { message: 'bad request' }));

    expect(await problemOf(createPos())).toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      code: ErrorCodes.MP_POS_CREATE_FAILED,
    });
  });

  it('un 5xx da 503 MP_UNAVAILABLE: es el único caso reintentable', async () => {
    fetchMock.mockResolvedValue(respond(500, { message: 'internal' }));

    expect(await problemOf(createPos())).toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: ErrorCodes.MP_UNAVAILABLE,
    });
  });

  /** 🔴 Un token en un log es un token filtrado: los logs se exportan y se indexan. */
  it('no loguea el code ni el client_secret, y redacta tokens del error de MP', async () => {
    fetchMock.mockResolvedValue(
      respond(400, { message: `token ${TOKEN} is invalid` }),
    );

    await client
      .exchangeAuthorizationCode('TG-el-code', 'el-verifier')
      .catch(() => undefined);

    const todo = logged.join('\n');
    expect(todo).not.toContain('TG-el-code');
    expect(todo).not.toContain('el-verifier');
    expect(todo).not.toContain(CLIENT_SECRET);
    expect(todo).not.toContain(TOKEN);
    expect(todo).toContain('[REDACTED]');
    // Pero sí dice QUÉ falló, que es para lo que sirve el log.
    expect(todo).toContain('exchange Mercado Pago authorization code');
  });

  // La doc de MP usa DOS nombres para el mismo objeto según la versión del
  // endpoint (`qr_response` en `/v2/pos`, `qr` en el `/pos` anterior). Se leen
  // las dos hasta confirmar en sandbox cuál llega: si elegimos mal, la
  // vinculación sale "exitosa" y el dueño se queda sin cartel.
  it.each(['qr_response', 'qr'])(
    'mapea el QR del POS desde `%s`',
    async (key) => {
      fetchMock.mockResolvedValue(
        respond(201, {
          id: 2711382,
          external_id: 'EXT',
          [key]: {
            image: 'https://mp.test/qr.png',
            template_document: 'https://mp.test/qr.pdf',
          },
        }),
      );

      const pos = await createPos();

      expect(pos.id).toBe('2711382');
      expect(pos.qrImageUrl).toBe('https://mp.test/qr.png');
      expect(pos.qrTemplateDocumentUrl).toBe('https://mp.test/qr.pdf');
    },
  );

  it('crea el Store con el user_id en el path y la ubicación en snake_case', async () => {
    fetchMock.mockResolvedValue(respond(201, { id: 1234567 }));

    const store = await client.createStore('token', '446566691', {
      name: 'Playa Centro',
      externalId: 'PARKITSTORE1',
      location: {
        streetName: 'Av. Corrientes',
        streetNumber: '1234',
        cityName: 'CABA',
        stateName: 'Buenos Aires',
        // Media coordenada le pone el local en el medio del océano al mapa de
        // MP, y la base ya lo prohíbe (`tenants_coordinates_paired`).
        latitude: -34.6,
      },
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.mercadopago.com/users/446566691/stores');
    expect(bodyOf().location).toEqual({
      street_name: 'Av. Corrientes',
      street_number: '1234',
      city_name: 'CABA',
      state_name: 'Buenos Aires',
    });
    expect(store.id).toBe('1234567');
  });
});
