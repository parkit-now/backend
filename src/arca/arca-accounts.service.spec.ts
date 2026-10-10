/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return --
   el Prisma en memoria guarda filas sin tipar y los tests leen campos sueltos. */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import forge from 'node-forge';
import type { AuditService } from '../audit/audit.service';
import { PermissionsService } from '../auth/permissions.service';
import type { PrismaService } from '../database/prisma.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { ArcaAccountsService } from './arca-accounts.service';
import { ArcaConfigService } from './arca-config.service';
import { ArcaCryptoService } from './arca-crypto.service';
import { ArcaAlreadyAuthenticatedError, ArcaAuthError } from './arca.gateway';
import { FakeArcaGateway } from './fake-arca.gateway';

const TENANT = '1a2b3c4d-1111-7111-8111-111111111111';
const CUIT = '20123456786';
const IIBB = '901-123456-7';
const USER = { id: 'user-1', role: 'user' } as User;

type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]: [string, unknown]) =>
    value instanceof Date
      ? row[key] === value
      : value !== null && typeof value === 'object' && 'gt' in value
        ? row[key] instanceof Date &&
          value.gt instanceof Date &&
          row[key] > value.gt
        : value === undefined
          ? true
          : value !== null && typeof value === 'object' && 'in' in value
            ? (value.in as unknown[]).includes(row[key])
            : value !== null && typeof value === 'object' && 'not' in value
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
  const arcaAccessTicket = {
    deleteMany: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue({}),
  };
  const prisma = {
    arcaAccount: {
      create: ({ data }: Row) => {
        const row = {
          id: `acc-${state.accounts.length + 1}`,
          ivaRate: 21,
          renewalCsrPem: null,
          ...data,
        };
        state.accounts.push(row);
        return Promise.resolve({ ...row });
      },
      findMany: ({ where, include }: Row) =>
        Promise.resolve(
          state.accounts
            .filter((row) => matches(row, where))
            .map((row) => ({
              ...row,
              ...((include as { tenant?: boolean } | undefined)?.tenant
                ? { tenant: { name: 'Estacionamiento Palermo' } }
                : {}),
            })),
        ),
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
      findFirst: ({ where }: Row) => {
        const row = find(where);
        return Promise.resolve(row ? { ...row } : null);
      },
      findUniqueOrThrow: ({ where }: Row) =>
        Promise.resolve({ ...find(where) }),
      updateMany: ({ where, data }: Row) => {
        const rows = state.accounts.filter((r) => matches(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return Promise.resolve({ count: rows.length });
      },
    },
    tenant: {
      findUniqueOrThrow: () =>
        Promise.resolve({ name: 'Estacionamiento Palermo' }),
    },
    paymentMethod,
    userMembership: {
      findMany: () => Promise.resolve([{ tenantId: TENANT, role: 'owner' }]),
    },
    invoice: { count: jest.fn().mockResolvedValue(0) },
    $executeRaw: jest.fn().mockResolvedValue(1),
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
    new PermissionsService(),
    gateway,
  );

  /** La clave que guardó el paso 1, descifrada, para firmar certificados. */
  const storedKey = () => {
    const row = state.accounts[0];
    return crypto.decrypt(row.keyEncrypted, row.keyVersion);
  };
  /** La clave de la renovación, para firmar el certificado renovado. */
  const renewalKey = () => {
    const row = state.accounts[0];
    return crypto.decrypt(row.renewalKeyEncrypted, row.renewalKeyVersion);
  };
  return {
    service,
    state,
    gateway,
    audit,
    paymentMethod,
    arcaAccessTicket,
    storedKey,
    renewalKey,
    prisma,
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
      service.create(TENANT, { cuit: '20-12345678-7', iibb: IIBB }),
    );

    expect(codeOf(error)).toBe('ARCA_CUIT_INVALID');
  });

  it('genera la solicitud y guarda la clave CIFRADA', async () => {
    const { service, state } = setup();

    const account = await service.create(TENANT, {
      cuit: '20-12345678-6',
      iibb: IIBB,
    });

    expect(account.status).toBe('pending_certificate');
    expect(account.cuit).toBe(CUIT);
    expect(account.certAlias).toBe('parkitestacionamientopalermo');
    expect(state.accounts[0].csrPem).toContain('CERTIFICATE REQUEST');
    expect(state.accounts[0].keyEncrypted).not.toContain('PRIVATE KEY');
  });

  it('una sede ya vinculada no arranca otra vinculación', async () => {
    const { service, state } = setup();
    await service.create(TENANT, { cuit: CUIT, iibb: IIBB });
    state.accounts[0].status = 'linked';

    const error = await rejection(
      service.create(TENANT, { cuit: CUIT, iibb: IIBB }),
    );

    expect(codeOf(error)).toBe('ARCA_ALREADY_LINKED');
  });
});

describe('ArcaAccountsService — paso 2 (certificado)', () => {
  it('certificado bueno y padrón vacío (homologación): pasa al punto de venta', async () => {
    const { service, storedKey } = setup();
    await service.create(TENANT, { cuit: CUIT, iibb: IIBB });

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
    await service.create(TENANT, { cuit: CUIT, iibb: IIBB });
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
    await service.create(TENANT, { cuit: CUIT, iibb: IIBB });

    const error = await rejection(
      service.uploadCertificate(TENANT, {
        certificate: certFor(storedKey(), '30500010912'),
      }),
    );

    expect(codeOf(error)).toBe('ARCA_CERT_CUIT_MISMATCH');
  });

  it('certificado de OTRA clave (no de nuestro CSR) → ARCA_CERT_KEY_MISMATCH', async () => {
    const { service } = setup();
    await service.create(TENANT, { cuit: CUIT, iibb: IIBB });
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
    await service.create(TENANT, { cuit: CUIT, iibb: IIBB });
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
    await service.create(TENANT, { cuit: CUIT, iibb: IIBB });

    const error = await rejection(
      service.uploadCertificate(TENANT, { certificate: 'hola' }),
    );

    expect(codeOf(error)).toBe('ARCA_CERT_INVALID');
  });
});

describe('ArcaAccountsService — paso 3 (punto de venta)', () => {
  async function certified(env = 'homologacion') {
    const ctx = setup(env);
    await ctx.service.create(TENANT, { cuit: CUIT, iibb: IIBB });
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

    const account = await service.setSalesPoint(TENANT, USER, {
      ptoVta: 2,
      inicioActividad: '2020-01-01',
    });

    expect(account.status).toBe('linked');
    expect(account.ptoVta).toBe(2);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'arca_account.linked' }),
    );
  });

  it('sin fecha de inicio de actividades no vincula → ARCA_FISCAL_DATA_INCOMPLETE', async () => {
    const { service, gateway } = await certified();
    const salesPoints = jest.spyOn(gateway, 'getSalesPoints');

    const error = await rejection(
      service.setSalesPoint(TENANT, USER, { ptoVta: 2 }),
    );

    expect(codeOf(error)).toBe('ARCA_FISCAL_DATA_INCOMPLETE');
    expect(salesPoints).not.toHaveBeenCalled();
  });

  it('un número que no está en la lista de web services → ARCA_POS_NOT_FOUND', async () => {
    const { service, gateway } = await certified();
    jest.spyOn(gateway, 'getSalesPoints').mockResolvedValue({
      resultGet: { ptoVenta: [{ nro: 1, bloqueado: 'N' }] },
    });

    const error = await rejection(
      service.setSalesPoint(TENANT, USER, {
        ptoVta: 5,
        inicioActividad: '2020-01-01',
      }),
    );

    expect(codeOf(error)).toBe('ARCA_POS_NOT_FOUND');
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
  it('reutiliza por ID el certificado de primaria y renueva ambas sin cambiar sus puntos de venta', async () => {
    const { service, state, storedKey, renewalKey } = setup();
    const primary = await service.create(TENANT, { cuit: CUIT, iibb: IIBB });
    await service.uploadCertificate(TENANT, {
      certificate: certFor(storedKey()),
    });
    Object.assign(state.accounts[0], { status: 'linked', ptoVta: 1 });
    const secondary = await service.create(TENANT, {
      cuit: CUIT,
      iibb: IIBB,
      role: 'secondary',
    });
    const reusable = await service.listReusableCertificates(
      TENANT,
      USER,
      secondary.id,
    );
    expect(reusable.map((item) => item.accountId)).toEqual([primary.id]);
    const reused = await service.reuseCertificate(
      TENANT,
      USER,
      { fromAccountId: primary.id },
      secondary.id,
    );
    expect(reused.status).toBe('pending_sales_point');
    expect(state.accounts[1].certFingerprint).toBe(
      state.accounts[0].certFingerprint,
    );
    Object.assign(state.accounts[1], { status: 'linked', ptoVta: 2 });
    await service.getRenewalCsr(TENANT, secondary.id);
    expect(state.accounts[1].renewalCsrPem).toBe(
      state.accounts[0].renewalCsrPem,
    );
    const originalFingerprint = state.accounts[0].certFingerprint;
    await service.uploadRenewalCertificate(
      TENANT,
      USER,
      { certificate: certFor(renewalKey()) },
      secondary.id,
    );
    expect(state.accounts[0].certFingerprint).not.toBe(originalFingerprint);
    expect(state.accounts[1].certFingerprint).toBe(
      state.accounts[0].certFingerprint,
    );
    expect(state.accounts.map((account) => account.ptoVta)).toEqual([1, 2]);
  });
  it('exige una primaria vinculada antes de crear secundaria', async () => {
    const { service, state } = setup();
    expect(
      codeOf(
        await rejection(
          service.create(TENANT, { cuit: CUIT, iibb: IIBB, role: 'secondary' }),
        ),
      ),
    ).toBe('ARCA_PRIMARY_REQUIRED');
    expect(state.accounts).toHaveLength(0);
  });

  it('acepta mismo CUIT con otro punto de venta, pero no uno duplicado', async () => {
    const { service, state } = setup();
    await service.create(TENANT, { cuit: CUIT, iibb: IIBB });
    Object.assign(state.accounts[0], { status: 'linked', ptoVta: 1 });
    const secondary = await service.create(TENANT, {
      cuit: CUIT,
      iibb: IIBB,
      role: 'secondary',
    });
    expect(secondary.certAlias).not.toBe('parkitestacionamientopalermo');
    const original = state.accounts[0];
    Object.assign(state.accounts[1], {
      ...original,
      id: secondary.id,
      role: 'secondary',
      status: 'pending_sales_point',
      ptoVta: null,
      condicionIva: 'monotributo',
      inicioActividad: new Date('2020-01-01'),
      certPem: 'CERT',
      certFingerprint: 'abc',
    });
    expect(
      codeOf(
        await rejection(
          service.setSalesPoint(TENANT, USER, { ptoVta: 1 }, secondary.id),
        ),
      ),
    ).toBe('ARCA_ACCOUNT_DUPLICATE');
    const linked = await service.setSalesPoint(
      TENANT,
      USER,
      { ptoVta: 2 },
      secondary.id,
    );
    expect(linked.ptoVta).toBe(2);
    expect(
      codeOf(
        await rejection(
          service.create(TENANT, { cuit: CUIT, iibb: IIBB, role: 'secondary' }),
        ),
      ),
    ).toBe('ARCA_ALREADY_LINKED');
  });

  it('desvincular secundaria conserva primaria y los modos; primaria quita ambas', async () => {
    const { service, state, paymentMethod } = setup();
    await service.create(TENANT, { cuit: CUIT, iibb: IIBB });
    state.accounts[0].status = 'linked';
    const secondary = await service.create(TENANT, {
      cuit: CUIT,
      iibb: IIBB,
      role: 'secondary',
    });
    await service.unlink(TENANT, USER, secondary.id);
    expect(state.accounts[0].status).toBe('linked');
    expect(paymentMethod.updateMany).not.toHaveBeenCalled();
    const replacement = await service.create(TENANT, {
      cuit: CUIT,
      iibb: IIBB,
      role: 'secondary',
    });
    expect(replacement.id).not.toBe(secondary.id);
    await service.unlink(TENANT, USER);
    expect(
      state.accounts.every((account) => account.status === 'unlinked'),
    ).toBe(true);
    expect(paymentMethod.updateMany).toHaveBeenCalledTimes(1);
  });

  it('bloquea la desvinculación si hay una emisión incierta', async () => {
    const { service, state, prisma } = setup();
    await service.create(TENANT, { cuit: CUIT, iibb: IIBB });
    prisma.invoice.count.mockResolvedValue(1);
    expect(codeOf(await rejection(service.unlink(TENANT, USER)))).toBe(
      'INVOICE_IN_PROGRESS',
    );
    expect(state.accounts[0].status).toBe('pending_certificate');
  });

  it('no permite gestionar una cuenta de otro estacionamiento', async () => {
    const { service } = setup();
    const account = await service.create(TENANT, { cuit: CUIT, iibb: IIBB });
    expect(
      codeOf(await rejection(service.getAccount('another-tenant', account.id))),
    ).toBe('ARCA_NOT_LINKED');
  });
  it('borra clave y certificado y pone todos los medios en none', async () => {
    const { service, state, storedKey, paymentMethod, arcaAccessTicket } =
      setup();
    await service.create(TENANT, { cuit: CUIT, iibb: IIBB });
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

describe('ArcaAccountsService — renovación del certificado', () => {
  async function linked() {
    const ctx = setup();
    await ctx.service.create(TENANT, { cuit: CUIT, iibb: IIBB });
    await ctx.service.uploadCertificate(TENANT, {
      certificate: certFor(ctx.storedKey()),
    });
    Object.assign(ctx.state.accounts[0], { status: 'linked', ptoVta: 1 });
    return ctx;
  }

  it('prepara el CSR con el mismo alias, sin tocar el certificado vigente, y lo reusa', async () => {
    const { service, state } = await linked();
    const certBefore = state.accounts[0].certPem;

    const first = await service.getRenewalCsr(TENANT);
    const again = await service.getRenewalCsr(TENANT);

    expect(first.alias).toBe('parkittest');
    expect(first.csrPem).toContain('CERTIFICATE REQUEST');
    expect(again.csrPem).toBe(first.csrPem);
    expect(state.accounts[0].certPem).toBe(certBefore);
    expect(state.accounts[0].renewalKeyEncrypted).not.toContain('PRIVATE KEY');
  });

  it('el certificado renovado reemplaza al vencido y la cuenta vuelve a linked', async () => {
    const { service, state, renewalKey, arcaAccessTicket } = await linked();
    const oldFingerprint = state.accounts[0].certFingerprint;
    state.accounts[0].status = 'cert_expired';
    await service.getRenewalCsr(TENANT);
    arcaAccessTicket.findMany.mockResolvedValue([
      {
        certFingerprint: oldFingerprint,
        service: 'wsfe',
        environment: 'homologacion',
      },
    ]);

    const account = await service.uploadRenewalCertificate(TENANT, USER, {
      certificate: certFor(renewalKey()),
    });

    expect(account.status).toBe('linked');
    expect(account.renewalPreparedAt).toBeNull();
    expect(state.accounts[0].certFingerprint).not.toBe(oldFingerprint);
    expect(state.accounts[0].renewalCsrPem).toBeNull();
    // El ticket vigente del certificado viejo pasa al nuevo.
    expect(arcaAccessTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { certFingerprint: state.accounts[0].certFingerprint },
      }),
    );
  });

  it('un certificado firmado con la clave VIEJA → ARCA_CERT_KEY_MISMATCH', async () => {
    const { service, storedKey } = await linked();
    await service.getRenewalCsr(TENANT);

    const error = await rejection(
      service.uploadRenewalCertificate(TENANT, USER, {
        certificate: certFor(storedKey()),
      }),
    );

    expect(codeOf(error)).toBe('ARCA_CERT_KEY_MISMATCH');
  });

  it('ARCA contesta alreadyAuthenticated (ticket del viejo vivo) → cuenta como verificado', async () => {
    const { service, gateway, renewalKey } = await linked();
    await service.getRenewalCsr(TENANT);
    jest
      .spyOn(gateway, 'getServerStatus')
      .mockRejectedValue(
        new ArcaAlreadyAuthenticatedError('coe.alreadyAuthenticated'),
      );

    const account = await service.uploadRenewalCertificate(TENANT, USER, {
      certificate: certFor(renewalKey()),
    });

    expect(account.status).toBe('linked');
  });
});
