import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MpAccountStatus, PaymentMethodType } from '@prisma/client';
import type { MpAccount } from '@prisma/client';
import { AuditActions, AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { MpApiClient } from './mp-api.client';
import { MpCryptoService } from './mp-crypto.service';
import { MpTokenService } from './mp-token.service';

const TENANT = '11111111-1111-7111-8111-111111111111';
const ACCOUNT = '55555555-5555-7555-8555-555555555555';
const EPOCH = new Date('2026-01-01T00:00:00.000Z');

const DAY_MS = 24 * 60 * 60 * 1000;

/** El access token EN PLANO que devuelve `decrypt` para la fila guardada. */
const CURRENT_ACCESS = 'APP_USR-token-actual';
/** El par EN PLANO que devuelve Mercado Pago al renovar. */
const NEW_ACCESS = 'APP_USR-token-nuevo';
const NEW_REFRESH = 'TG-refresh-nuevo';

describe('MpTokenService', () => {
  let service: MpTokenService;

  const tx = {
    mpAccount: { update: jest.fn() },
    paymentMethod: { updateMany: jest.fn() },
  };
  const prisma = {
    mpAccount: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const audit = { record: jest.fn() };
  const crypto = { encrypt: jest.fn(), decrypt: jest.fn() };
  const mpApi = { refreshAccessToken: jest.fn() };

  const makeAccount = (overrides: Partial<MpAccount> = {}): MpAccount => ({
    id: ACCOUNT,
    tenantId: TENANT,
    mpUserId: '446566691',
    accessToken: 'ciphertext-del-access-token',
    refreshToken: 'ciphertext-del-refresh-token',
    tokenKeyVersion: 1,
    // Bien lejos del margen de 30 días: el default es el camino feliz.
    accessTokenExpiresAt: new Date(Date.now() + 120 * DAY_MS),
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
        MpTokenService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: MpCryptoService, useValue: crypto },
        { provide: MpApiClient, useValue: mpApi },
      ],
    }).compile();

    service = module.get<MpTokenService>(MpTokenService);
    jest.clearAllMocks();

    // Defaults del camino feliz; cada test sobreescribe sólo lo suyo.
    prisma.mpAccount.findUnique.mockResolvedValue(makeAccount());
    prisma.$transaction.mockImplementation(
      (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );
    audit.record.mockResolvedValue(undefined);
    // `decrypt` distingue las dos columnas: un test que confunda el access con
    // el refresh token tiene que fallar, no pasar de casualidad.
    crypto.decrypt.mockImplementation((ciphertext: string) =>
      ciphertext.includes('refresh') ? 'TG-refresh-actual' : CURRENT_ACCESS,
    );
    crypto.encrypt.mockImplementation((plaintext: string) => ({
      ciphertext: `cifrado(${plaintext})`,
      keyVersion: 2,
    }));
    mpApi.refreshAccessToken.mockResolvedValue({
      accessToken: NEW_ACCESS,
      refreshToken: NEW_REFRESH,
      mpUserId: '446566691',
      accessTokenExpiresAt: new Date(Date.now() + 180 * DAY_MS),
    });
  });

  /**
   * El camino del 99% de los cobros: si hay margen, NO se habla con Mercado
   * Pago. Un refresh por cobro le colgaría un round-trip de red a cada QR
   * generado para renovar algo que vence dentro de meses.
   */
  it('con más de 30 días de margen devuelve el token actual sin llamar a Mercado Pago', async () => {
    const result = await service.getUsableAccessToken(TENANT);

    expect(result.accessToken).toBe(CURRENT_ACCESS);
    expect(mpApi.refreshAccessToken).not.toHaveBeenCalled();
    expect(prisma.mpAccount.update).not.toHaveBeenCalled();
  });

  /**
   * 🔴 Lo que se persiste tiene que ser CIFRADO. El test compara contra el
   * texto plano explícitamente: un `data.accessToken` con el token en claro
   * pasaría cualquier assert que sólo mire que "se guardó algo", y sería
   * exactamente el bug que el cifrado viene a evitar.
   */
  it('a menos de 30 días renueva, guarda el par CIFRADO y resetea el contador', async () => {
    prisma.mpAccount.findUnique.mockResolvedValue(
      makeAccount({
        accessTokenExpiresAt: new Date(Date.now() + 10 * DAY_MS),
        refreshFailureCount: 2,
      }),
    );
    prisma.mpAccount.update.mockResolvedValue(makeAccount());

    const result = await service.getUsableAccessToken(TENANT);

    expect(result.accessToken).toBe(NEW_ACCESS);

    const { data } = prisma.mpAccount.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data.accessToken).toBe(`cifrado(${NEW_ACCESS})`);
    expect(data.refreshToken).toBe(`cifrado(${NEW_REFRESH})`);
    expect(data.accessToken).not.toBe(NEW_ACCESS);
    expect(data.refreshToken).not.toBe(NEW_REFRESH);
    // La versión sale de la clave ACTIVA, no de la que traía la fila: es lo que
    // hace que renovar re-cifre con la clave nueva después de una rotación.
    expect(data.tokenKeyVersion).toBe(2);
    // Contador de fallos CONSECUTIVOS: un éxito lo vuelve a cero.
    expect(data.refreshFailureCount).toBe(0);
    expect(data.lastRefreshAt).toBeInstanceOf(Date);
  });

  /**
   * 🔴 Un 500 de Mercado Pago NO puede dejar a una playa sin cobrar. El token
   * actual sigue vigente, así que se sirve ése y se anota el fallo: quedan
   * hasta 30 días para que algún request posterior consiga renovar.
   */
  it('si el refresh falla con el token vigente devuelve el actual y sólo suma un fallo', async () => {
    prisma.mpAccount.findUnique.mockResolvedValue(
      makeAccount({ accessTokenExpiresAt: new Date(Date.now() + 10 * DAY_MS) }),
    );
    prisma.mpAccount.update.mockResolvedValue(
      makeAccount({ refreshFailureCount: 1 }),
    );
    mpApi.refreshAccessToken.mockRejectedValue(new Error('MP caído'));

    const result = await service.getUsableAccessToken(TENANT);

    expect(result.accessToken).toBe(CURRENT_ACCESS);

    // El incremento lo hace Postgres (`increment`), no una cuenta en JS: dos
    // cobros que fallan a la vez perderían uno de los dos fallos.
    const { data } = prisma.mpAccount.update.mock.calls[0][0] as {
      data: { refreshFailureCount: { increment: number } };
    };
    expect(data.refreshFailureCount).toEqual({ increment: 1 });

    // NO se degrada: la cuenta sigue operativa y el medio de pago prendido.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.paymentMethod.updateMany).not.toHaveBeenCalled();
  });

  /**
   * Al tercer fallo consecutivo el vínculo está roto de verdad. Apagar el medio
   * de pago es la mitad que importa: sin eso el operario seguiría viendo
   * "Mercado Pago QR" en la pantalla de cobro y se comería un 502 delante del
   * cliente.
   */
  it('al tercer fallo consecutivo degrada la cuenta y apaga el medio de pago', async () => {
    prisma.mpAccount.findUnique.mockResolvedValue(
      makeAccount({
        accessTokenExpiresAt: new Date(Date.now() + 10 * DAY_MS),
        refreshFailureCount: 2,
      }),
    );
    prisma.mpAccount.update.mockResolvedValue(
      makeAccount({ refreshFailureCount: 3 }),
    );
    mpApi.refreshAccessToken.mockRejectedValue(new Error('MP caído'));

    const problem = await problemOf(service.getUsableAccessToken(TENANT));

    expect(problem).toMatchObject({
      status: HttpStatus.CONFLICT,
      code: ErrorCodes.MP_ACCOUNT_TOKEN_EXPIRED,
    });

    expect(tx.mpAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: MpAccountStatus.token_expired },
      }),
    );
    // Se DESHABILITA, nunca se borra: es `isSystem` y hay transacciones
    // históricas que lo referencian. `isDefault: false` además evita que quede
    // preseleccionado un medio apagado.
    expect(tx.paymentMethod.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, type: PaymentMethodType.mercadopago_qr },
      data: { enabled: false, isDefault: false },
    });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditActions.MP_ACCOUNT_TOKEN_EXPIRED,
        tenantId: TENANT,
        // `crit`, no `warn`: la playa perdió un medio de cobro y no se
        // recupera sola.
        severity: 'crit',
      }),
    );
  });

  /**
   * Sin colchón no hay tolerancia que valga: el token que devolveríamos no
   * sirve, así que esperar los 3 fallos sólo cambiaría un 409 accionable
   * ("re-vinculá") por un 502 críptico en la pantalla de cobro.
   */
  it('si el refresh falla con el token YA vencido degrada al primer fallo', async () => {
    prisma.mpAccount.findUnique.mockResolvedValue(
      makeAccount({ accessTokenExpiresAt: new Date(Date.now() - 1000) }),
    );
    prisma.mpAccount.update.mockResolvedValue(
      makeAccount({ refreshFailureCount: 1 }),
    );
    mpApi.refreshAccessToken.mockRejectedValue(new Error('MP caído'));

    const problem = await problemOf(service.getUsableAccessToken(TENANT));

    expect(problem).toMatchObject({
      code: ErrorCodes.MP_ACCOUNT_TOKEN_EXPIRED,
    });
    // Un solo fallo y ya degradó: no esperó a los 3.
    expect(tx.paymentMethod.updateMany).toHaveBeenCalled();
  });

  /**
   * `revoked` es terminal: el dueño le sacó el permiso a la aplicación, así que
   * el `refresh_token` tampoco sirve. Intentar renovar es un round-trip
   * garantizado a un rechazo.
   */
  it('con la cuenta revocada corta con MP_ACCOUNT_REVOKED sin tocar Mercado Pago', async () => {
    prisma.mpAccount.findUnique.mockResolvedValue(
      makeAccount({ status: MpAccountStatus.revoked }),
    );

    const problem = await problemOf(service.getUsableAccessToken(TENANT));

    expect(problem).toMatchObject({
      status: HttpStatus.CONFLICT,
      code: ErrorCodes.MP_ACCOUNT_REVOKED,
    });
    expect(mpApi.refreshAccessToken).not.toHaveBeenCalled();
  });

  describe('refreshExpiringTokens (cron diario)', () => {
    it('renueva sólo las cuentas vinculadas con menos de 30 días', async () => {
      prisma.mpAccount.findMany.mockResolvedValue([
        makeAccount({
          accessTokenExpiresAt: new Date(Date.now() + 10 * DAY_MS),
        }),
      ]);
      prisma.mpAccount.update.mockResolvedValue(makeAccount());

      const result = await service.refreshExpiringTokens();

      expect(result).toEqual({ refreshed: 1, failed: 0 });
      const { where } = prisma.mpAccount.findMany.mock.calls[0][0] as {
        where: { status: string; accessTokenExpiresAt: { lte: Date } };
      };
      expect(where.status).toBe(MpAccountStatus.linked);
      expect(where.accessTokenExpiresAt.lte.getTime()).toBeLessThanOrEqual(
        Date.now() + 30 * DAY_MS,
      );
      expect(mpApi.refreshAccessToken).toHaveBeenCalledTimes(1);
    });

    it('un fallo con el token vigente se cuenta y no corta la corrida', async () => {
      prisma.mpAccount.findMany.mockResolvedValue([
        makeAccount({
          accessTokenExpiresAt: new Date(Date.now() + 10 * DAY_MS),
        }),
        makeAccount({
          id: 'otra',
          tenantId: 'otra-playa',
          accessTokenExpiresAt: new Date(Date.now() + 10 * DAY_MS),
        }),
      ]);
      mpApi.refreshAccessToken
        .mockRejectedValueOnce(new Error('MP caído'))
        .mockResolvedValueOnce({
          accessToken: NEW_ACCESS,
          refreshToken: NEW_REFRESH,
          mpUserId: '446566691',
          accessTokenExpiresAt: new Date(Date.now() + 180 * DAY_MS),
        });
      prisma.mpAccount.update
        .mockResolvedValueOnce(makeAccount({ refreshFailureCount: 1 }))
        .mockResolvedValueOnce(makeAccount());

      const result = await service.refreshExpiringTokens();

      expect(result).toEqual({ refreshed: 1, failed: 1 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
