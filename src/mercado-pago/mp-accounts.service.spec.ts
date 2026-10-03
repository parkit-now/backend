import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  MembershipRole,
  MpAccountStatus,
  PaymentMethodType,
  UserRole,
} from '@prisma/client';
import type { MpAccount, MpOauthState, Tenant, User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PermissionsService } from '../auth/permissions.service';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import {
  MP_PAYMENT_METHOD_NAME,
  MpAccountsService,
} from './mp-accounts.service';
import { MpApiClient } from './mp-api.client';
import { MpConfigService } from './mp-config.service';
import { MpCryptoService } from './mp-crypto.service';
import { MpTokenService } from './mp-token.service';

const TENANT = '11111111-1111-7111-8111-111111111111';
const USER = '22222222-2222-7222-8222-222222222222';
const STATE = '44444444-4444-7444-8444-444444444444';
const EPOCH = new Date('2026-01-01T00:00:00.000Z');

describe('MpAccountsService', () => {
  let service: MpAccountsService;

  const tx = {
    mpAccount: { upsert: jest.fn(), update: jest.fn() },
    paymentMethod: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const prisma = {
    mpAccount: { findUnique: jest.fn(), update: jest.fn() },
    mpOauthState: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
    tenant: { findUnique: jest.fn() },
    reservation: { count: jest.fn() },
    userMembership: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  const audit = { record: jest.fn() };
  const crypto = { encrypt: jest.fn(), decrypt: jest.fn() };
  const mpApi = {
    exchangeAuthorizationCode: jest.fn(),
    createStore: jest.fn(),
    findStoreByExternalId: jest.fn(),
    createPos: jest.fn(),
    findPosByExternalId: jest.fn(),
    getPos: jest.fn(),
  };
  // Mockeado y no el real: el ciclo de vida del token lo cubre
  // `mp-token.service.spec.ts`. Acá sólo importa que el resync le pida el token
  // a ÉL y no descifre por su cuenta.
  const tokens = { getUsableAccessToken: jest.fn() };

  const user: User = {
    id: USER,
    role: UserRole.user,
    email: 'duenio@parkit.test',
    name: 'Dueño',
    createdAt: EPOCH,
  };

  /** Playa con la dirección estructurada COMPLETA: pasa el gate de Mercado Pago. */
  const makeTenant = (overrides: Partial<Tenant> = {}): Tenant => ({
    id: TENANT,
    name: 'Playa Centro',
    legalName: null,
    cuit: null,
    email: null,
    phone: null,
    address: 'Av. Corrientes 1234, CABA',
    status: 'active',
    settings: {},
    lprImageRetentionDays: 30,
    entryCameraId: null,
    entryCameraLabel: null,
    streetName: 'Av. Corrientes',
    streetNumber: '1234',
    floor: null,
    cityName: 'CABA',
    stateName: 'Buenos Aires',
    postalCode: null,
    latitude: null,
    longitude: null,
    geocodingSource: 'manual',
    geocodedAt: null,
    createdAt: EPOCH,
    ...overrides,
  });

  const state: MpOauthState = {
    state: STATE,
    tenantId: TENANT,
    userId: USER,
    codeVerifier: 'verifier-de-pkce',
    returnPath: '/configuracion/cobros',
    createdAt: EPOCH,
    consumedAt: null,
    expiresAt: new Date(Date.now() + 300_000),
  };

  const owner = {
    userId: USER,
    tenantId: TENANT,
    role: MembershipRole.owner,
    createdAt: EPOCH,
  };

  const makeAccount = (overrides: Partial<MpAccount> = {}): MpAccount => ({
    id: '55555555-5555-7555-8555-555555555555',
    tenantId: TENANT,
    mpUserId: '446566691',
    accessToken: 'ciphertext-del-access-token',
    refreshToken: 'ciphertext-del-refresh-token',
    tokenKeyVersion: 1,
    accessTokenExpiresAt: new Date(Date.now() + 86_400_000),
    status: MpAccountStatus.linked,
    storeId: '1234567',
    posId: '2711382',
    externalPosId: 'PARKITPOS1111',
    qrImageUrl: 'https://mp.test/qr.png',
    qrTemplateDocumentUrl: 'https://mp.test/qr.pdf',
    refreshFailureCount: 0,
    lastRefreshAt: null,
    linkedAt: EPOCH,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  });

  /** Devuelve el ProblemDetails de una promesa que TIENE que fallar. */
  const problemOf = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(FormattedException);
      return (error as FormattedException).getResponse();
    }
    throw new Error('La promesa resolvió y tenía que fallar');
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MpAccountsService,
        // El de verdad, no un mock: es puro y sin base, así el test verifica la
        // REGLA de permisos y no una imitación que puede divergir.
        PermissionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        {
          provide: MpConfigService,
          useValue: {
            clientId: 'app-id',
            oauthRedirectUri: 'https://p.test/cb',
          },
        },
        { provide: MpCryptoService, useValue: crypto },
        { provide: MpApiClient, useValue: mpApi },
        { provide: MpTokenService, useValue: tokens },
      ],
    }).compile();

    service = module.get<MpAccountsService>(MpAccountsService);
    jest.clearAllMocks();

    // Defaults del camino feliz; cada test sobreescribe sólo lo suyo.
    prisma.mpOauthState.updateMany.mockResolvedValue({ count: 1 });
    prisma.mpOauthState.findUnique.mockResolvedValue(state);
    prisma.tenant.findUnique.mockResolvedValue(makeTenant());
    prisma.userMembership.findUnique.mockResolvedValue(owner);
    prisma.mpAccount.findUnique.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(
      (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );
    tx.paymentMethod.findFirst.mockResolvedValue(null);
    tx.mpAccount.upsert.mockResolvedValue(makeAccount());
    // `record` devuelve `Promise<void>`: el service le encadena un `.catch()`
    // para que un fallo del audit no tape el error real de la vinculación.
    audit.record.mockResolvedValue(undefined);
    crypto.encrypt.mockReturnValue({ ciphertext: 'ciphertext', keyVersion: 1 });
    mpApi.exchangeAuthorizationCode.mockResolvedValue({
      accessToken: 'APP_USR-access',
      refreshToken: 'TG-refresh',
      mpUserId: '446566691',
      accessTokenExpiresAt: new Date(Date.now() + 1000),
    });
    mpApi.createStore.mockResolvedValue({ id: '1234567' });
    mpApi.createPos.mockResolvedValue({
      id: '2711382',
      externalId: 'PARKITPOS1111',
      storeId: '1234567',
      qrImageUrl: 'https://mp.test/qr.png',
      qrTemplateDocumentUrl: 'https://mp.test/qr.pdf',
    });
    // El default es "no existe nada": el camino de una vinculación primera.
    mpApi.findStoreByExternalId.mockResolvedValue(null);
    mpApi.findPosByExternalId.mockResolvedValue(null);
  });

  /**
   * 🔴 La atomicidad la da Postgres (`UPDATE ... WHERE consumed_at IS NULL`), no
   * nuestro código: un `jest.fn()` no tiene transacciones. Lo NUESTRO, y lo que
   * cuida este test, es que el `where` lleve las guardas en UNA sola sentencia.
   * Partido en SELECT + UPDATE, dos callbacks simultáneos canjean el mismo state.
   */
  it('canja el state en UNA sentencia, con las guardas de uso y vencimiento', async () => {
    await service.handleCallback('code', STATE, user);

    const args = prisma.mpOauthState.updateMany.mock.calls[0][0] as {
      where: {
        state: string;
        userId: string;
        consumedAt: null;
        expiresAt: { gt: Date };
      };
      data: { consumedAt: Date };
    };
    expect(args.where.state).toBe(STATE);
    expect(args.where.consumedAt).toBeNull();
    expect(args.where.expiresAt.gt).toBeInstanceOf(Date);
    // El `user_id` va DENTRO del WHERE (no como chequeo posterior) para que un
    // tercero con el state no pueda quemárselo al dueño legítimo.
    expect(args.where.userId).toBe(USER);
    expect(args.data.consumedAt).toBeInstanceOf(Date);
  });

  /**
   * Los cuatro fallos de state —inexistente, consumido, vencido, de otro
   * usuario— son UN caso acá, y no por simplificar el test: las cuatro viven en
   * el `WHERE` de esa misma sentencia, así que las cuatro llegan como "no tocó
   * ninguna fila". Cuál falló ni lo sabemos, que es justo la propiedad buscada:
   * sin ella el endpoint sería un oráculo para enumerar states ajenos.
   */
  it('rechaza un state que no se pudo canjear, con un error genérico', async () => {
    prisma.mpOauthState.updateMany.mockResolvedValue({ count: 0 });

    expect(
      await problemOf(service.handleCallback('code', STATE, user)),
    ).toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      code: ErrorCodes.MP_OAUTH_STATE_INVALID,
      detail:
        'The Mercado Pago OAuth state is invalid, expired, already used, or does not belong to the caller.',
    });
    expect(mpApi.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  // Entre el `/authorize` y el callback pasan hasta 10 minutos: a esa persona la
  // pudieron bajar de `owner` en el medio, y vuelve con el mismo error genérico.
  it('rechaza a quien ya no es owner de la playa', async () => {
    prisma.userMembership.findUnique.mockResolvedValue({
      ...owner,
      role: MembershipRole.operator,
    });

    expect(
      await problemOf(service.handleCallback('code', STATE, user)),
    ).toMatchObject({ code: ErrorCodes.MP_OAUTH_STATE_INVALID });
    expect(mpApi.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  /** 🔴 Sin esto el callback es un open redirect con nuestro dominio adelante. */
  it.each([
    '//evil.com',
    'https://evil.com',
    'javascript:alert(1)',
    '/\\evil.com',
    'evil.com',
  ])('rechaza el returnPath externo %s', async (returnPath) => {
    const problem = await problemOf(
      service.buildAuthorizationUrl(TENANT, user, { returnPath }),
    );

    expect(problem).toMatchObject({ status: HttpStatus.BAD_REQUEST });
    // Lo importante no es sólo el 400: es que NO se guardó el state.
    expect(prisma.mpOauthState.create).not.toHaveBeenCalled();
  });

  it('arma la URL con PKCE S256 y SIN parámetro scope', async () => {
    const { authorizationUrl } = await service.buildAuthorizationUrl(
      TENANT,
      user,
      {},
    );

    const url = new URL(authorizationUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    // Mercado Pago NO usa `scope` en este flujo: mandarlo hace que rechace.
    expect(url.searchParams.has('scope')).toBe(false);
  });

  it('rechaza con 422 y NO llama a Mercado Pago si falta la dirección', async () => {
    prisma.tenant.findUnique.mockResolvedValue(
      makeTenant({ streetNumber: null, cityName: null }),
    );

    expect(
      await problemOf(service.handleCallback('code', STATE, user)),
    ).toMatchObject({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: ErrorCodes.MP_ENTITY_ADDRESS_INCOMPLETE,
    });
    expect(mpApi.exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  /**
   * 🔴 `upsert`, NO `create`: re-vincular es un caso NORMAL (el token vence) y
   * con `create` se comería un P2002 contra el unique de `tenant_id`.
   */
  it('re-vincular una cuenta en token_expired la deja en linked', async () => {
    prisma.mpAccount.findUnique.mockResolvedValue(
      makeAccount({
        status: MpAccountStatus.token_expired,
        refreshFailureCount: 3,
      }),
    );

    await service.handleCallback('code', STATE, user);

    const args = tx.mpAccount.upsert.mock.calls[0][0] as {
      where: { tenantId: string };
      update: { status: MpAccountStatus; refreshFailureCount: number };
    };
    expect(args.where).toEqual({ tenantId: TENANT });
    expect(args.update.status).toBe(MpAccountStatus.linked);
    // Los tokens son NUEVOS: arrastrar el contador de fallos haría que el cron
    // de refresh marque vencida una cuenta recién vinculada.
    expect(args.update.refreshFailureCount).toBe(0);
  });

  it('crea el método de pago mercadopago_qr como método de sistema', async () => {
    await service.handleCallback('code', STATE, user);

    expect(tx.paymentMethod.create).toHaveBeenCalledWith({
      data: {
        tenantId: TENANT,
        type: PaymentMethodType.mercadopago_qr,
        name: MP_PAYMENT_METHOD_NAME,
        isSystem: true,
      },
    });
  });

  // Las llamadas a Mercado Pago corren AFUERA de la transacción: un fallo no
  // puede dejar una fila a medio escribir que el panel muestre como si la playa
  // pudiera cobrar.
  it('un fallo contra Mercado Pago da 502 y no escribe nada', async () => {
    mpApi.createPos.mockRejectedValue(
      new FormattedException(
        'Bad Gateway',
        HttpStatus.BAD_GATEWAY,
        'Could not reach Mercado Pago',
        '/mercado-pago/oauth/callback',
        ErrorCodes.MP_POS_CREATE_FAILED,
      ),
    );

    expect(
      await problemOf(service.handleCallback('code', STATE, user)),
    ).toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      code: ErrorCodes.MP_POS_CREATE_FAILED,
    });
    expect(tx.mpAccount.upsert).not.toHaveBeenCalled();
    expect(tx.paymentMethod.create).not.toHaveBeenCalled();
  });

  /**
   * 🔴 EL BUG. Los dos `external_id` salen del `tenant_id`, así que un intento
   * que creó el Store y murió en el POS deja el Store HUÉRFANO —vivo en MP, sin
   * que nosotros tengamos su id, porque el flujo no persiste nada si falla— y
   * todo reintento choca contra `already assigned`. Para siempre, y pagando un
   * paseo por la pantalla de autorización de MP cada vez.
   */
  it('adopta el Store y el POS que ya existen en vez de crearlos de nuevo', async () => {
    mpApi.findStoreByExternalId.mockResolvedValue({ id: '7654321' });
    mpApi.findPosByExternalId.mockResolvedValue({
      id: '9999999',
      externalId: 'PARKITPOS1111',
      storeId: '7654321',
      qrImageUrl: 'https://mp.test/adoptado.png',
      qrTemplateDocumentUrl: 'https://mp.test/adoptado.pdf',
    });

    await service.handleCallback('code', STATE, user);

    expect(mpApi.createStore).not.toHaveBeenCalled();
    expect(mpApi.createPos).not.toHaveBeenCalled();

    const { create } = tx.mpAccount.upsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
    };
    expect(create.storeId).toBe('7654321');
    expect(create.posId).toBe('9999999');
    // Adoptar un POS y quedarse sin QR deja la vinculación "exitosa" y al dueño
    // sin nada que imprimir: el resultado tiene que ser INDISTINGUIBLE de crear.
    expect(create.qrImageUrl).toBe('https://mp.test/adoptado.png');
    expect(create.qrTemplateDocumentUrl).toBe('https://mp.test/adoptado.pdf');
  });

  /**
   * La carrera: entre el `find` y el `create` alguien más lo creó (doble click,
   * retry de un proxy). Se re-busca ante CUALQUIER fallo del alta y no parseando
   * el "already assigned" del mensaje: ese texto es prosa que MP puede cambiar.
   */
  it('si el alta del Store choca con uno preexistente, lo vuelve a buscar y lo adopta', async () => {
    mpApi.findStoreByExternalId
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: '7654321' });
    mpApi.createStore.mockRejectedValue(
      new FormattedException(
        'Bad Gateway',
        HttpStatus.BAD_GATEWAY,
        "Mercado Pago returned 400: external id 'PARKITSTORE1' is already assigned to this user 1178299265",
        '/mercado-pago/oauth/callback',
        ErrorCodes.MP_STORE_CREATE_FAILED,
      ),
    );

    await service.handleCallback('code', STATE, user);

    // La caja se cuelga del Store ADOPTADO, no de uno nuevo que nunca existió.
    const [, posInput] = mpApi.createPos.mock.calls[0] as [
      string,
      { storeId: string },
    ];
    expect(posInput.storeId).toBe('7654321');
  });

  /** La `X-Idempotency-Key` con la que se intentó el alta número `call`. */
  const keyDelPos = (call: number): string =>
    (mpApi.createPos.mock.calls[call] as [string, unknown, string])[2];

  /**
   * 🔴 `POST /v2/pos` EXIGE la `X-Idempotency-Key` —sin ella MP contesta
   * `400 Missing X-Idempotency-Key header`—, y la calcula el service, no el
   * cliente HTTP.
   *
   * DETERMINÍSTICA: es un hash del body del alta, sin nada aleatorio ni de
   * reloj. Con una key aleatoria cada reintento fabricaría una caja nueva, o sea
   * los recursos huérfanos que el find-or-create acaba de resolver.
   */
  it('manda al alta del POS una X-Idempotency-Key determinística por playa', async () => {
    await service.handleCallback('code', STATE, user);
    await service.handleCallback('code', STATE, user);

    // sha256 en hex, como la de los intentos de pago: la key viaja a los logs
    // de un tercero, así que va hasheada y no con los campos en crudo.
    expect(keyDelPos(0)).toMatch(/^[0-9a-f]{64}$/);
    // Mismo tenant, mismo nombre, mismo store ⇒ MISMO body ⇒ misma key.
    expect(keyDelPos(1)).toBe(keyDelPos(0));
  });

  /**
   * La otra mitad del determinismo: que no sea una CONSTANTE. Dos playas con
   * la misma key se pisan —la segunda se come un `409
   * idempotency_key_already_used` por 24 h, o peor, la caja de la otra—.
   */
  it('la X-Idempotency-Key del POS es distinta para cada playa', async () => {
    await service.handleCallback('code', STATE, user);

    prisma.tenant.findUnique.mockResolvedValue(
      makeTenant({ id: '33333333-3333-7333-8333-333333333333' }),
    );
    await service.handleCallback('code', STATE, user);

    expect(keyDelPos(1)).not.toBe(keyDelPos(0));
  });

  /**
   * 🔴 LA KEY ES UN HASH DEL BODY, no sólo del `external_id`.
   *
   * MP devuelve `409 idempotency_key_already_used` cuando le llega una key ya
   * vista con un body distinto, y la ventana es de 24 h. Si el dueño renombra la
   * playa entre dos intentos, el `name` del body cambia: con una key derivada
   * sólo del `external_id` quedaba TRABADO un día entero, sin más salida que
   * esperar. Con la huella del body ese 409 no existe como caso.
   *
   * El duplicado lo sigue frenando el `external_id` + `adoptOrCreate`, que es
   * otro mecanismo y no se toca: MP rechaza el alta repetida con "already
   * assigned" y la caja existente se adopta.
   */
  it('renombrar la playa cambia la key: el body distinto no reusa la anterior', async () => {
    await service.handleCallback('code', STATE, user);

    prisma.tenant.findUnique.mockResolvedValue(
      makeTenant({ name: 'Playa Centro Renovada' }),
    );
    await service.handleCallback('code', STATE, user);

    // El `external_id` NO cambió (sale del `tenant_id`, que es el mismo): lo
    // único distinto es el `name`. Si la key fuera la misma, esto sería el 409.
    const [, input] = mpApi.createPos.mock.calls[1] as [
      string,
      { name: string; externalId: string },
    ];
    expect(input.name).toBe('Playa Centro Renovada');
    expect(input.externalId).toBe(
      (mpApi.createPos.mock.calls[0] as [string, { externalId: string }])[1]
        .externalId,
    );
    expect(keyDelPos(1)).not.toBe(keyDelPos(0));
  });

  /**
   * El otro campo del body que puede moverse solo: el `store_id`, si el Store
   * se recreara. Mismo razonamiento que el rename.
   */
  it('un store_id distinto también cambia la key del POS', async () => {
    mpApi.createStore
      .mockResolvedValueOnce({ id: '1234567' })
      .mockResolvedValue({ id: '7654321' });

    await service.handleCallback('code', STATE, user);
    await service.handleCallback('code', STATE, user);

    expect(keyDelPos(1)).not.toBe(keyDelPos(0));
  });

  /**
   * 🔴 Sin el mensaje de MP, cada fallo es una caja negra: `reason` dice QUÉ
   * code falló, pero el POR QUÉ —"already assigned", una categoría MCC
   * inválida, lo que sea— vivía sólo en el log de Cloud Run. Ya nos pasó.
   */
  it('audita el mensaje real de Mercado Pago, no sólo el ErrorCode', async () => {
    mpApi.createPos.mockRejectedValue(
      new FormattedException(
        'Bad Gateway',
        HttpStatus.BAD_GATEWAY,
        'Mercado Pago returned 400 while trying to create Mercado Pago POS: invalid category',
        '/mercado-pago/oauth/callback',
        ErrorCodes.MP_POS_CREATE_FAILED,
      ),
    );

    await problemOf(service.handleCallback('code', STATE, user));

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          reason: ErrorCodes.MP_POS_CREATE_FAILED,
          detail:
            'Mercado Pago returned 400 while trying to create Mercado Pago POS: invalid category',
        },
      }),
    );
  });

  /**
   * 🔴 La clase de bug que se cuela en un refactor: alguien cambia el mapper por
   * un spread del modelo y publica los tokens sin que nadie lo note.
   */
  it('el DTO de la cuenta NO contiene tokens ni ciphertext', async () => {
    const account = makeAccount();
    prisma.mpAccount.findUnique.mockResolvedValue(account);

    const dto = await service.getAccount(TENANT);

    expect(Object.keys(dto)).not.toContain('accessToken');
    expect(Object.keys(dto)).not.toContain('refreshToken');
    expect(Object.keys(dto)).not.toContain('tokenKeyVersion');
    // Y tampoco el VALOR, por si apareciera con otro nombre.
    expect(JSON.stringify(dto)).not.toContain(account.accessToken);
    expect(JSON.stringify(dto)).not.toContain(account.refreshToken);
    // `MpAccount` NO está en TENANT_MODELS: sin este `where` la query cruza
    // playas y no hay red abajo que lo atrape.
    expect(prisma.mpAccount.findUnique).toHaveBeenCalledWith({
      where: { tenantId: TENANT },
    });
  });

  describe('unlink', () => {
    beforeEach(() => {
      prisma.mpAccount.findUnique.mockResolvedValue(makeAccount());
      prisma.reservation.count.mockResolvedValue(0);
      prisma.$transaction.mockImplementation(
        (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            mpAccount: { update: jest.fn() },
            paymentMethod: { updateMany: jest.fn() },
          }),
      );
    });

    it('con reservas activas: 409 MP_ACCOUNT_HAS_ACTIVE_RESERVATIONS y no toca nada', async () => {
      prisma.reservation.count.mockResolvedValue(2);

      expect(await problemOf(service.unlink(TENANT, user))).toMatchObject({
        status: HttpStatus.CONFLICT,
        code: 'MP_ACCOUNT_HAS_ACTIVE_RESERVATIONS',
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('cuenta como activas: futuras confirmadas/por aprobar, retenciones vigentes y reembolsos pendientes de ESTA playa', async () => {
      await service.unlink(TENANT, user);

      const { where } = prisma.reservation.count.mock.calls[0][0] as {
        where: { tenantId: string; OR: Record<string, unknown>[] };
      };
      expect(where.tenantId).toBe(TENANT);
      expect(where.OR).toEqual([
        {
          status: { in: ['confirmed', 'pending_approval'] },
          entryAt: { gt: expect.any(Date) as Date },
        },
        {
          status: 'pending_payment',
          holdExpiresAt: { gt: expect.any(Date) as Date },
        },
        { refundStatus: 'pending' },
      ]);
    });

    it('sin reservas activas: desvincula', async () => {
      await service.unlink(TENANT, user);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledTimes(1);
    });
  });
});
