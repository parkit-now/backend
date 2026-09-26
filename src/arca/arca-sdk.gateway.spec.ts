import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../database/prisma.service';
import { ArcaConfigService } from './arca-config.service';
import { ArcaCryptoService } from './arca-crypto.service';
import { ArcaSdkGateway, classifyWsaaError } from './arca-sdk.gateway';
import type { ArcaCredentials } from './arca.gateway';

const CREDS: ArcaCredentials = {
  cuit: '20447275865',
  certPem: 'CERT',
  keyPem: 'KEY',
  certFingerprint: 'abc',
  environment: 'homologacion',
};

const LOGIN = {
  header: [{ version: '1.0' }, {}],
  credentials: { token: 'T', sign: 'S' },
};

function setup(ticket: { expiresAt: Date } | null) {
  const env: Record<string, string> = {
    ARCA_ENV: 'homologacion',
    ARCA_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  };
  const config = new ArcaConfigService({
    get: (k: string) => env[k],
    getOrThrow: (k: string) => env[k],
  } as unknown as ConfigService);
  config.onModuleInit();
  const crypto = new ArcaCryptoService(config);
  const encrypted = crypto.encrypt(JSON.stringify(LOGIN));
  const row = ticket && {
    credentialsEncrypted: encrypted.ciphertext,
    keyVersion: encrypted.keyVersion,
    expiresAt: ticket.expiresAt,
  };

  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    arcaAccessTicket: {
      findUnique: jest.fn().mockResolvedValue(row),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
  };
  const prisma = {
    arcaAccessTicket: { findUnique: jest.fn().mockResolvedValue(row) },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const gateway = new ArcaSdkGateway(
    prisma as unknown as PrismaService,
    config,
    crypto,
  );
  const accessTicket = {
    toLoginCredentials: () => LOGIN,
    getExpiration: () => new Date(Date.now() + 12 * 3_600_000),
  };
  const login = jest
    .spyOn(gateway as unknown as { login: () => Promise<unknown> }, 'login')
    .mockResolvedValue(accessTicket);
  return { gateway, prisma, tx, login };
}

const ticketFor = (gateway: ArcaSdkGateway) =>
  (
    gateway as unknown as {
      ticketFor(c: ArcaCredentials, s: string): Promise<unknown>;
    }
  ).ticketFor(CREDS, 'wsfe');

describe('ArcaSdkGateway — ticket del WSAA', () => {
  it('reusa el ticket vigente de la base: no pide login ni toma el lock', async () => {
    const { gateway, prisma, login } = setup({
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    expect(await ticketFor(gateway)).toEqual(LOGIN);
    expect(login).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('sin ticket: login bajo advisory lock y lo guarda cifrado', async () => {
    const { gateway, tx, login } = setup(null);

    expect(await ticketFor(gateway)).toEqual(LOGIN);
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(login).toHaveBeenCalledTimes(1);
    const saved = tx.arcaAccessTicket.upsert.mock.calls[0][0] as {
      create: { credentialsEncrypted: string };
    };
    expect(saved.create.credentialsEncrypted).not.toContain('"token"');
  });

  it('un ticket a punto de vencer se renueva', async () => {
    const { gateway, login } = setup({
      expiresAt: new Date(Date.now() + 60_000),
    });

    await ticketFor(gateway);
    expect(login).toHaveBeenCalledTimes(1);
  });
});

describe('classifyWsaaError', () => {
  it('servicio no asociado al certificado → not_authorized', () => {
    expect(
      classifyWsaaError(
        'ns1:coe.notAuthorized: Computador no autorizado a acceder al servicio',
      )?.kind,
    ).toBe('not_authorized');
  });

  it('certificado de otro entorno o vencido → cert_rejected', () => {
    expect(
      classifyWsaaError(
        'ns1:cms.cert.untrusted: Certificado no emitido por AC de confianza',
      )?.kind,
    ).toBe('cert_rejected');
  });

  it('un corte de red no es un rechazo del certificado', () => {
    expect(classifyWsaaError('socket hang up')).toBeNull();
  });
});
