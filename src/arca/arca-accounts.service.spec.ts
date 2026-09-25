/* eslint-disable @typescript-eslint/no-unsafe-argument -- el Prisma en memoria
   guarda filas sin tipar y los tests leen campos sueltos. */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import forge from 'node-forge';
import type { AuditService } from '../audit/audit.service';
import type { PermissionsService } from '../auth/permissions.service';
import type { PrismaService } from '../database/prisma.service';
import type { StorageService } from '../storage/storage.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { ArcaAccountsService } from './arca-accounts.service';
import { ArcaConfigService } from './arca-config.service';
import { ArcaCryptoService } from './arca-crypto.service';
import { ArcaAuthError } from './arca.gateway';
import { FakeArcaGateway } from './fake-arca.gateway';

const TENANT = '1a2b3c4d-1111-7111-8111-111111111111';
const CUIT = '20123456786';
const USER = { id: 'user-1', role: 'user' } as User;

type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]: [string, unknown]) =>
    value !== null && typeof value === 'object' && 'not' in value
      ? row[key] !== value.not
      : row[key] === value,
  );
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Se esperaba que la promesa fallara.');
}

function codeOf(error: unknown): string | undefined {
  return ((error as FormattedException).getResponse() as { code?: string })
    .code;
}

/** Certificado "de ARCA" autofirmado para la clave que generó Parkit. */
function certFor(keyPem: string, cuit = CUIT): string {
  const key = forge.pki.privateKeyFromPem(keyPem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  const subject = [
    { shortName: 'CN', value: 'parkittest' },
    { name: 'serialNumber', value: `CUIT ${cuit}` },
  ];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.sign(key, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

function setup(environment = 'homologacion') {
  const env: Record<string, string> = {
    ARCA_ENV: environment,
    ARCA_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  };
  const config = new ArcaConfigService({
    get: (k: string) => env[k],
    getOrThrow: (k: string) => env[k],
  } as unknown as ConfigService);
  config.onModuleInit();
  const crypto = new ArcaCryptoService(config);

  const state = { accounts: [] as Row[] };
  const find = (where: Row) => state.accounts.find((r) => matches(r, where));
  const paymentMethod = { updateMany: jest.fn().mockResolvedValue({}) };
  const arcaAccessTicket = { deleteMany: jest.fn().mockResolvedValue({}) };
  const prisma = {
    arcaAccount: {
      // Copia, como Prisma: el servicio no puede ver cambios posteriores.
      findUnique: ({ where }: Row) => {
        const row = find(where);
        return Promise.resolve(row ? { ...row } : null);
      },
      upsert: ({ where, create, update }: Row) => {
        const row = find(where);
        if (row) Object.assign(row, update);
        else state.accounts.push({ id: 'acc-1', ivaRate: 21, ...create });
        return Promise.resolve({ ...find(where) });
      },
      update: ({ where, data }: Row) => {
        const row = find(where)!;
        for (const [k, v] of Object.entries(data)) {
          if (v !== undefined) row[k] = v;
        }
        return Promise.resolve({ ...row });
      },
      count: ({ where }: Row) =>
        Promise.resolve(state.accounts.filter((r) => matches(r, where)).length),
    },
    paymentMethod,
    arcaAccessTicket,
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const gateway = new FakeArcaGateway();
  const service = new ArcaAccountsService(
    prisma as unknown as PrismaService,
    config,
    crypto,
    audit as unknown as AuditService,
    {} as PermissionsService,
    {} as StorageService,
    gateway,
  );

  /** La clave que guardó el paso 1, descifrada, para firmar certificados. */
  const storedKey = () => {
    const row = state.accounts[0];
    return crypto.decrypt(row.keyEncrypted, row.keyVersion);
  };
  return {
    service,
    state,
    gateway,
    audit,
    paymentMethod,
    arcaAccessTicket,
    storedKey,
  };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

describe('ArcaAccountsService — paso 1 (CUIT)', () => {
  it('un CUIT con el verificador mal → ARCA_CUIT_INVALID', async () => {
    const { service } = setup();

    const error = await rejection(
      service.create(TENANT, { cuit: '20-12345678-7' }),
    );

    expect(codeOf(error)).toBe('ARCA_CUIT_INVALID');
  });

  it('genera la solicitud y guarda la clave CIFRADA', async () => {
    const { service, state } = setup();

    const account = await service.create(TENANT, { cuit: '20-12345678-6' });

    expect(account.status).toBe('pending_certificate');
    expect(account.cuit).toBe(CUIT);
    expect(account.certAlias).toBe('parkit1a2b3c4d');
    expect(state.accounts[0].csrPem).toContain('CERTIFICATE REQUEST');
    expect(state.accounts[0].keyEncrypted).not.toContain('PRIVATE KEY');
  });

  it('una sede ya vinculada no arranca otra vinculación', async () => {
    const { service, state } = setup();
    await service.create(TENANT, { cuit: CUIT });
    state.accounts[0].status = 'linked';

    const error = await rejection(service.create(TENANT, { cuit: CUIT }));

    expect(codeOf(error)).toBe('ARCA_ALREADY_LINKED');
  });
});

describe('ArcaAccountsService — paso 2 (certificado)', () => {
  it('certificado bueno y padrón vacío (homologación): pasa al punto de venta', async () => {
    const { service, storedKey } = setup();
    await service.create(TENANT, { cuit: CUIT });

    const result = await service.uploadCertificate(TENANT, {
      certificate: certFor(storedKey()),
    });

    expect(result.padronFound).toBe(false);
    expect(result.account.status).toBe('pending_sales_point');
    expect(result.account.condicionIva).toBeNull();
    expect(result.account.certExpiresAt).not.toBeNull();
  });

  it('con el padrón: guarda los datos fiscales', async () => {
    const { service, gateway, storedKey } = setup();
    await service.create(TENANT, { cuit: CUIT });
    jest.spyOn(gateway, 'getTaxpayerDetails').mockResolvedValue({
      datosGenerales: { razonSocial: 'PARKIT SA' },
      datosMonotributo: {},
    });

    const result = await service.uploadCertificate(TENANT, {
      certificate: certFor(storedKey()),
    });

    expect(result.padronFound).toBe(true);
    expect(result.account.razonSocial).toBe('PARKIT SA');
    expect(result.account.condicionIva).toBe('monotributo');
  });

  it('certificado de otro CUIT → ARCA_CERT_CUIT_MISMATCH', async () => {
    const { service, storedKey } = setup();
    await service.create(TENANT, { cuit: CUIT });

    const error = await rejection(
      service.uploadCertificate(TENANT, {
        certificate: certFor(storedKey(), '30500010912'),
      }),
    );

    expect(codeOf(error)).toBe('ARCA_CERT_CUIT_MISMATCH');
  });

  it('certificado de OTRA clave (no de nuestro CSR) → ARCA_CERT_KEY_MISMATCH', async () => {
    const { service } = setup();
    await service.create(TENANT, { cuit: CUIT });
    const other = forge.pki.rsa.generateKeyPair(1024);

    const error = await rejection(
      service.uploadCertificate(TENANT, {
        certificate: certFor(forge.pki.privateKeyToPem(other.privateKey)),
      }),
    );

    expect(codeOf(error)).toBe('ARCA_CERT_KEY_MISMATCH');
  });

  it('servicio sin asociar en ARCA → ARCA_CERT_NOT_AUTHORIZED', async () => {
    const { service, gateway, storedKey } = setup();
    await service.create(TENANT, { cuit: CUIT });
    jest
      .spyOn(gateway, 'getServerStatus')
      .mockRejectedValue(
        new ArcaAuthError('not_authorized', 'coe.notAuthorized: no autorizado'),
      );

    const error = await rejection(
      service.uploadCertificate(TENANT, { certificate: certFor(storedKey()) }),
    );

    expect(codeOf(error)).toBe('ARCA_CERT_NOT_AUTHORIZED');
  });

  it('un archivo que no es certificado → ARCA_CERT_INVALID', async () => {
    const { service } = setup();
    await service.create(TENANT, { cuit: CUIT });

    const error = await rejection(
      service.uploadCertificate(TENANT, { certificate: 'hola' }),
    );

    expect(codeOf(error)).toBe('ARCA_CERT_INVALID');
  });
});

describe('ArcaAccountsService — paso 3 (punto de venta)', () => {
  async function certified(env = 'homologacion') {
    const ctx = setup(env);
    await ctx.service.create(TENANT, { cuit: CUIT });
    jest.spyOn(ctx.gateway, 'getTaxpayerDetails').mockResolvedValue({
      datosGenerales: { razonSocial: 'PARKIT SA' },
      datosRegimenGeneral: { impuesto: [{ idImpuesto: 30 }] },
    });
    await ctx.service.uploadCertificate(TENANT, {
      certificate: certFor(ctx.storedKey()),
    });
    return ctx;
  }

  it('homologación sin puntos de venta: alcanza con que responda getLastVoucher', async () => {
    const { service, audit } = await certified();

    const account = await service.setSalesPoint(TENANT, USER, { ptoVta: 2 });

    expect(account.status).toBe('linked');
    expect(account.ptoVta).toBe(2);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'arca_account.linked' }),
    );
  });

  it('un número que no está en la lista de web services → ARCA_POS_NOT_FOUND', async () => {
    const { service, gateway } = await certified();
    jest.spyOn(gateway, 'getSalesPoints').mockResolvedValue({
      resultGet: { ptoVenta: [{ nro: 1, bloqueado: 'N' }] },
    });

    const error = await rejection(
      service.setSalesPoint(TENANT, USER, { ptoVta: 5 }),
    );

    expect(codeOf(error)).toBe('ARCA_POS_NOT_FOUND');
  });

  it('en producción, sin la constancia no se vincula', async () => {
    const { service } = await certified('produccion');

    const error = await rejection(
      service.setSalesPoint(TENANT, USER, { ptoVta: 2 }),
    );

    expect(codeOf(error)).toBe('ARCA_POS_CONSTANCIA_REQUIRED');
  });

  it('en producción los datos fiscales no se editan a mano', async () => {
    const { service } = await certified('produccion');

    const error = await rejection(
      service.update(TENANT, { condicionIva: 'monotributo' }),
    );

    expect(codeOf(error)).toBe('ARCA_LINK_STEP_INVALID');
  });
});

describe('ArcaAccountsService — desvincular', () => {
  it('borra clave y certificado y pone todos los medios en none', async () => {
    const { service, state, storedKey, paymentMethod, arcaAccessTicket } =
      setup();
    await service.create(TENANT, { cuit: CUIT });
    await service.uploadCertificate(TENANT, {
      certificate: certFor(storedKey()),
    });

    await service.unlink(TENANT, USER);

    expect(state.accounts[0]).toMatchObject({
      status: 'unlinked',
      keyEncrypted: null,
      certPem: null,
    });
    expect(paymentMethod.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, invoiceMode: { not: 'none' } },
      data: { invoiceMode: 'none' },
    });
    expect(arcaAccessTicket.deleteMany).toHaveBeenCalled();
    expect(codeOf(await rejection(service.getAccount(TENANT)))).toBe(
      'ARCA_NOT_LINKED',
    );
  });
});
