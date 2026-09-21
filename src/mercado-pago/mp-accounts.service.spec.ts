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
    userMembership: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  const audit = { record: jest.fn() };
  const crypto = { encrypt: jest.fn(), decrypt: jest.fn() };
  const mpApi = {
    exchangeAuthorizationCode: jest.fn(),
    createStore: jest.fn(),
    createPos: jest.fn(),
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
      qrImageUrl: 'https://mp.test/qr.png',
      qrTemplateDocumentUrl: 'https://mp.test/qr.pdf',
    });
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
});
