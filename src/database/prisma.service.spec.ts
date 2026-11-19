import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { PrismaService } from './prisma.service';
import { TenantContextService } from './tenant-context.service';

describe('PrismaService pool lifecycle', () => {
  let service: PrismaService;
  let pool: Pool;
  const names = [
    'DATABASE_URL',
    'DATABASE_POOL_MAX',
    'DATABASE_POOL_CONNECT_TIMEOUT_MS',
    'DATABASE_POOL_IDLE_TIMEOUT_MS',
    'K_REVISION',
  ];
  let previous: (string | undefined)[];

  beforeEach(() => {
    previous = names.map((name) => process.env[name]);
    names.forEach((name) => delete process.env[name]);
    process.env.DATABASE_URL =
      'postgresql://test:private-test-password@localhost:1/no_database';
    process.env.DATABASE_POOL_MAX = '2';
    service = new PrismaService(new TenantContextService());
    pool = (service as unknown as { pool: Pool }).pool;
  });
  afterEach(async () => {
    if (!pool.ended) await pool.end();
    names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    });
    jest.restoreAllMocks();
  });

  it('wires the configured external pool and logs only non-secret settings', async () => {
    expect(pool.options.max).toBe(2);
    expect(pool.options.connectionTimeoutMillis).toBe(5000);
    expect(pool.totalCount).toBe(0);
    const connect = jest.fn().mockResolvedValue(undefined);
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    await PrismaService.prototype.onModuleInit.call({
      $connect: connect,
      pool,
      logger: new Logger(PrismaService.name),
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'Database pool ready (max=2, connectTimeoutMs=5000, idleTimeoutMs=10000)',
    );
  });

  it('handles idle connection failures without logging raw credentials or crashing', () => {
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    expect(() =>
      pool.emit(
        'error',
        new Error('postgresql://test:private-test-password@localhost'),
      ),
    ).not.toThrow();
    expect(log).toHaveBeenCalledWith(
      'Database idle connection failed (total=0, idle=0, waiting=0)',
    );
  });

  it('disconnects Prisma and closes its external pool', async () => {
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const end = jest.spyOn(pool, 'end');
    await PrismaService.prototype.onModuleDestroy.call({
      $disconnect: disconnect,
      pool,
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(pool.ended).toBe(true);
  });

  it('still closes the pool if disconnecting Prisma fails', async () => {
    const disconnect = jest
      .fn()
      .mockRejectedValue(new Error('disconnect failed'));
    const end = jest.spyOn(pool, 'end');
    const destroying = PrismaService.prototype.onModuleDestroy.call({
      $disconnect: disconnect,
      pool,
    }) as Promise<void>;
    const error: unknown = await destroying.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('disconnect failed');
    expect(end).toHaveBeenCalledTimes(1);
    expect(pool.ended).toBe(true);
  });
});
