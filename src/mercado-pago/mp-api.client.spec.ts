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

  const headersOf = (): Record<string, string> => {
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    return init.headers;
  };

  /** El id del intent (UUIDv7) es el `external_reference`: opaco y sin PII. */
  const INTENT_ID = '0199c2a0-7f3b-7c1d-9e2a-3f4b5c6d7e8f';

  const createOrder = () =>
    client.createOrder(
      'token',
      {
        externalReference: INTENT_ID,
        externalPosId: 'PARKITPOS1',
        totalAmount: '1500.00',
        // 🔴 Genérica y fija: la patente es un dato personal y MP prohíbe PII acá.
        description: 'Estadía de estacionamiento',
        expirationTime: 'PT5M',
        items: [
          {
            title: 'Estadía de estacionamiento',
            unitPrice: '1500.00',
            quantity: 1,
            unitMeasure: 'unit',
          },
        ],
      },
      `create:${INTENT_ID}`,
    );

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

  it('falla con 502 MP_MALFORMED_RESPONSE si la respuesta no trae refresh_token', async () => {
    // Una cuenta sin refresh_token queda muerta al primer vencimiento, y nadie
    // se entera hasta que el dueño no puede cobrar.
    fetchMock.mockResolvedValue(
      respond(200, { access_token: 'a', user_id: 1, expires_in: 10 }),
    );

    expect(
      await problemOf(client.exchangeAuthorizationCode('c', 'v')),
    ).toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      code: ErrorCodes.MP_MALFORMED_RESPONSE,
    });
  });

  // 🔴 Este code es lo que separa "la orden NO existe" de "no sabemos si
  // existe". Si vuelve a ser el de la operación, `PaymentIntentsService` no
  // puede distinguir un rechazo de un timeout y marca `failed` una orden que
  // quizás quedó viva sobre el QR de la caja.
  it('un fallo de red (o el timeout) da 502 MP_UNREACHABLE, no el code de la operación', async () => {
    fetchMock.mockRejectedValue(new Error('The operation timed out.'));

    expect(await problemOf(createPos())).toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      code: ErrorCodes.MP_UNREACHABLE,
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

  /**
   * ⚠️ La asimetría de MP: stores devuelve `results`, pos devuelve `data`.
   * Leer la clave equivocada no rompe nada visible — devuelve "no encontré
   * nada" SIEMPRE— y con eso vuelve intacto el bug que esto viene a arreglar.
   */
  it('busca el Store por external_id y lee `results`', async () => {
    fetchMock.mockResolvedValue(
      respond(200, {
        paging: { total: 1 },
        results: [{ id: 1234567, external_id: 'PARKITSTORE1' }],
      }),
    );

    const store = await client.findStoreByExternalId(
      'token',
      '446566691',
      'PARKITSTORE1',
    );

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      'https://api.mercadopago.com/users/446566691/stores/search?external_id=PARKITSTORE1',
    );
    expect(store).toEqual({ id: '1234567' });
  });

  it('busca el POS por external_id y lee `data`, con el QR de la búsqueda', async () => {
    fetchMock.mockResolvedValue(
      respond(200, {
        paging: { total: 1 },
        data: [
          {
            id: 2711382,
            external_id: 'PARKITPOS1',
            // MP lo manda como STRING acá; el `id` del Store viene como número.
            store_id: '1234567',
            qr_response: {
              image: 'https://mp.test/qr.png',
              template_document: 'https://mp.test/qr.pdf',
            },
          },
        ],
      }),
    );

    const pos = await client.findPosByExternalId('token', 'PARKITPOS1');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      'https://api.mercadopago.com/v2/pos?external_id=PARKITPOS1',
    );
    expect(pos?.id).toBe('2711382');
    expect(pos?.storeId).toBe('1234567');
    // 🔴 Adoptar un POS sin QR deja al dueño sin cartel para imprimir, con la
    // vinculación "exitosa". El QR viene en la búsqueda igual que en el alta.
    expect(pos?.qrImageUrl).toBe('https://mp.test/qr.png');
    expect(pos?.qrTemplateDocumentUrl).toBe('https://mp.test/qr.pdf');
  });

  // "No existe" es la mitad NORMAL del find-or-create: es lo que pasa en toda
  // vinculación primera. Si tirara, ninguna playa nueva podría vincularse.
  it('una búsqueda sin resultados devuelve null y NO es un error', async () => {
    fetchMock.mockResolvedValue(respond(200, { paging: { total: 0 } }));

    expect(
      await client.findStoreByExternalId('token', '446566691', 'NOPE'),
    ).toBeNull();
    expect(await client.findPosByExternalId('token', 'NOPE')).toBeNull();
  });

  /**
   * 🔴 Un vendedor puede tener varias playas nuestras en la misma cuenta de MP,
   * y no está documentado que el filtro matchee exacto y no por prefijo.
   * Adoptar la sucursal de OTRA playa cuelga su QR de la caja equivocada.
   */
  it('no adopta un recurso cuyo external_id no es EXACTAMENTE el pedido', async () => {
    fetchMock.mockResolvedValue(
      respond(200, {
        results: [{ id: 999, external_id: 'PARKITSTORE1OTRAPLAYA' }],
      }),
    );

    expect(
      await client.findStoreByExternalId('token', '446566691', 'PARKITSTORE1'),
    ).toBeNull();
  });

  it('crea la Order en modo QR estático, con montos string y sin PII', async () => {
    fetchMock.mockResolvedValue(
      respond(201, {
        id: 'ORD01K0',
        status: 'created',
        status_detail: 'created',
        external_reference: INTENT_ID,
      }),
    );

    const order = await createOrder();

    const body = bodyOf();
    expect(body.type).toBe('qr');
    // `static` = el QR impreso de la caja. Si esto pasa a `dynamic` o `hybrid`,
    // el PDF del cartel que generamos al vincular queda inservible.
    expect(body.config).toEqual({
      qr: { external_pos_id: 'PARKITPOS1', mode: 'static' },
    });
    expect(body.processing_mode).toBe('automatic');
    // STRING decimal, no number: los tres montos.
    expect(body.total_amount).toBe('1500.00');
    expect(body.transactions).toEqual({ payments: [{ amount: '1500.00' }] });
    expect(body.items).toEqual([
      {
        title: 'Estadía de estacionamiento',
        unit_price: '1500.00',
        quantity: 1,
        unit_measure: 'unit',
      },
    ]);
    // Duración RELATIVA, no un timestamp: es lo que la hace estable entre
    // reintentos con la misma idempotency key.
    expect(body.expiration_time).toBe('PT5M');
    expect(body.external_reference).toBe(INTENT_ID);
    // `notification_url` no existe en Orders: el webhook se configura a nivel
    // aplicación.
    expect(body.notification_url).toBeUndefined();
    // 🔴 Ni la descripción ni el ítem pueden llevar la patente (dato personal).
    expect(JSON.stringify(body)).not.toContain('ABC123');
    expect(order.status).toBe('created');
  });

  it('createOrder manda la X-Idempotency-Key que recibe, sin inventarla', async () => {
    fetchMock.mockResolvedValue(respond(201, { id: 'ORD01K0' }));

    await createOrder();

    // La key la deriva el service del id del intent y la namespacea por
    // operación: determinística para que el reintento devuelva la orden
    // original en vez de duplicarla.
    expect(headersOf()['X-Idempotency-Key']).toBe(`create:${INTENT_ID}`);
  });

  it('getOrder NO manda X-Idempotency-Key: los GET no la llevan', async () => {
    fetchMock.mockResolvedValue(respond(200, { id: 'ORD01K0' }));

    await client.getOrder('token', 'ORD01K0');

    expect(headersOf()['X-Idempotency-Key']).toBeUndefined();
  });

  it('un error de MP creando la Order da 502 MP_ORDER_CREATE_FAILED', async () => {
    fetchMock.mockResolvedValue(
      respond(400, { message: 'invalid external_reference' }),
    );

    expect(await problemOf(createOrder())).toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      code: ErrorCodes.MP_ORDER_CREATE_FAILED,
    });
  });
});
