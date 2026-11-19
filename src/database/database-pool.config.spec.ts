import { EventEmitter } from 'node:events';
import { Pool, type ClientBase } from 'pg';
import { databasePoolConfig } from './database-pool.config';

describe('databasePoolConfig', () => {
  it('uses a small per-process pool with bounded acquisition and idle time', () => {
    expect(databasePoolConfig({})).toMatchObject({
      max: 3,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
      application_name: 'parkit-backend',
    });
  });

  it('accepts explicit limits and labels the Cloud Run revision', () => {
    expect(
      databasePoolConfig({
        DATABASE_POOL_MAX: ' 4 ',
        DATABASE_POOL_CONNECT_TIMEOUT_MS: '7000',
        DATABASE_POOL_IDLE_TIMEOUT_MS: '20000',
        K_REVISION: 'backend-00054-test',
      }),
    ).toMatchObject({
      max: 4,
      connectionTimeoutMillis: 7000,
      idleTimeoutMillis: 20000,
      application_name: 'parkit-backend:backend-00054-test',
    });
    expect(
      databasePoolConfig({ K_REVISION: 'a'.repeat(100) }).application_name
        ?.length,
    ).toBe(63);
  });

  it.each(['5432', '6543'])(
    'does not rewrite the URL or silently switch port %s',
    (port) => {
      const url = `postgresql://user:secret@example.invalid:${port}/db?sslmode=require&connection_limit=99`;
      expect(databasePoolConfig({ DATABASE_URL: url })).toMatchObject({
        connectionString: url,
        max: 3,
      });
    },
  );

  for (const name of [
    'DATABASE_POOL_MAX',
    'DATABASE_POOL_CONNECT_TIMEOUT_MS',
    'DATABASE_POOL_IDLE_TIMEOUT_MS',
  ]) {
    it.each([
      '0',
      '-1',
      '1.2',
      '1e2',
      'Infinity',
      'NaN',
      '3connections',
      '2147483648',
    ])(`${name} rejects %s`, (value) => {
      expect(() => databasePoolConfig({ [name]: value })).toThrow(name);
    });
  }

  it('uses defaults for unset or blank optional settings without leaking values in errors', () => {
    expect(databasePoolConfig({ DATABASE_POOL_MAX: ' ' }).max).toBe(3);
    try {
      databasePoolConfig({
        DATABASE_URL: 'postgresql://secret',
        DATABASE_POOL_MAX: 'sensitive-value',
      });
      throw new Error('Expected validation to fail');
    } catch (error) {
      expect((error as Error).message).toBe(
        'DATABASE_POOL_MAX must be an integer between 1 and 2147483647',
      );
    }
  });
});

// Ejercita la cola real de pg.Pool sin abrir sockets ni usar una base de datos.
class MemoryClient extends EventEmitter {
  _queryable = true;
  _ending = false;
  connect(callback: (error: Error | null) => void) {
    queueMicrotask(() => callback(null));
  }
  end(callback?: () => void) {
    this._ending = true;
    this.emit('end');
    callback?.();
  }
}

function memoryPool(env: NodeJS.ProcessEnv = {}) {
  return new Pool({
    ...databasePoolConfig(env),
    Client: MemoryClient as unknown as new () => ClientBase,
  });
}

describe('bounded pg pool', () => {
  it('queues an extra request and reuses a connection instead of exceeding its budget', async () => {
    const pool = memoryPool();
    const clients = await Promise.all([
      pool.connect(),
      pool.connect(),
      pool.connect(),
    ]);
    const waiting = pool.connect();
    expect(pool.totalCount).toBe(3);
    expect(pool.waitingCount).toBe(1);
    clients[0].release();
    const next = await waiting;
    expect(next).toBe(clients[0]);
    expect(pool.totalCount).toBe(3);
    expect(pool.waitingCount).toBe(0);
    next.release();
    clients[1].release();
    clients[2].release();
    await pool.end();
    expect(pool.totalCount).toBe(0);
  });

  it('times out queued acquisition and can serve the next request after release', async () => {
    const pool = memoryPool({
      DATABASE_POOL_MAX: '1',
      DATABASE_POOL_CONNECT_TIMEOUT_MS: '50',
    });
    const held = await pool.connect();
    const error: unknown = await pool.connect().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('timeout exceeded');
    expect(pool.totalCount).toBe(1);
    expect(pool.waitingCount).toBe(0);
    held.release();
    const next = await pool.connect();
    next.release();
    await pool.end();
  });
});
