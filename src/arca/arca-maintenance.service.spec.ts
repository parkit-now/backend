import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../database/prisma.service';
import type { ArcaAccountsService } from './arca-accounts.service';
import type { ArcaConfigService } from './arca-config.service';
import {
  ArcaMaintenanceService,
  JOB_STALE_ISSUING_MS,
} from './arca-maintenance.service';
import type { InvoicesService } from './invoices.service';

const NOW = new Date('2026-09-25T08:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function account(id: string, fingerprint: string, expiresInDays: number) {
  return {
    id,
    tenantId: `tenant-${id}`,
    cuit: '20447275865',
    environment: 'homologacion',
    status: 'linked',
    certPem: 'CERT',
    keyEncrypted: 'KEY',
    keyVersion: 1,
    certFingerprint: fingerprint,
    certExpiresAt: new Date(NOW.getTime() + expiresInDays * DAY),
  };
}

type Where = { renewalCsrPem?: null; certExpiresAt: Record<string, Date> };

function setup(env: Record<string, string> = {}) {
  const toRenew = [account('a', 'fp-1', 20), account('b', 'fp-1', 20)];
  const expired = [account('c', 'fp-2', -1)];
  const prisma = {
    arcaAccount: {
      findMany: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(where.renewalCsrPem === null ? toRenew : expired),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoice: { count: jest.fn().mockResolvedValue(3) },
  };
  const accounts = {
    prepareRenewal: jest.fn().mockResolvedValue({ csrPem: 'CSR' }),
  };
  const invoices = {
    reconcileStaleIssuing: jest
      .fn()
      .mockResolvedValue({ reconciled: 3, failed: 0 }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new ArcaMaintenanceService(
    prisma as unknown as PrismaService,
    { get: (k: string) => env[k] } as unknown as ConfigService,
    {
      enabled: true,
      environment: 'homologacion',
    } as unknown as ArcaConfigService,
    accounts as unknown as ArcaAccountsService,
    invoices as unknown as InvoicesService,
    audit as unknown as AuditService,
  );
  return { service, prisma, accounts, invoices, audit };
}

describe('ArcaMaintenanceService', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());
  afterAll(() => jest.restoreAllMocks());

  it('por defecto es dry run: cuenta candidatos y no toca nada', async () => {
    const { service, prisma, accounts, invoices } = setup();

    const result = await service.run();

    expect(result).toEqual({
      dryRun: true,
      renewalsPrepared: 1,
      expiredMarked: 1,
      invoicesReconciled: 3,
    });
    expect(accounts.prepareRenewal).not.toHaveBeenCalled();
    expect(prisma.arcaAccount.updateMany).not.toHaveBeenCalled();
    expect(invoices.reconcileStaleIssuing).not.toHaveBeenCalled();
  });

  it('busca los certificados que vencen en 30 días o menos', async () => {
    const { service, prisma } = setup();

    await service.run();

    const [[{ where }]] = prisma.arcaAccount.findMany.mock.calls.filter(
      ([arg]) => arg.where.renewalCsrPem === null,
    );
    expect(where.certExpiresAt.lte).toEqual(new Date(NOW.getTime() + 30 * DAY));
  });

  it('con DRY_RUN=false: una renovación por certificado, marca vencidos y reconcilia', async () => {
    const { service, prisma, accounts, invoices, audit } = setup({
      ARCA_MAINTENANCE_DRY_RUN: 'false',
    });

    const result = await service.run();

    expect(result).toEqual({
      dryRun: false,
      renewalsPrepared: 1,
      expiredMarked: 1,
      invoicesReconciled: 3,
    });
    // Las sedes a y b comparten el certificado: se prepara una sola vez.
    expect(accounts.prepareRenewal).toHaveBeenCalledTimes(1);
    expect(prisma.arcaAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'cert_expired' } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'arca_account.certificate_expired',
        severity: 'warn',
      }),
    );
    expect(invoices.reconcileStaleIssuing).toHaveBeenCalledWith(
      expect.objectContaining({ olderThanMs: JOB_STALE_ISSUING_MS }),
    );
  });

  it('una renovación que falla no corta las demás tareas', async () => {
    const { service, accounts, invoices } = setup({
      ARCA_MAINTENANCE_DRY_RUN: 'false',
    });
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    accounts.prepareRenewal.mockRejectedValue(new Error('boom'));

    const result = await service.run();

    expect(result.renewalsPrepared).toBe(0);
    expect(invoices.reconcileStaleIssuing).toHaveBeenCalled();
  });
});
