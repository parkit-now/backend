import type { PoolConfig } from 'pg';

function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 2_147_483_647
  ) {
    throw new Error(`${name} must be an integer between 1 and 2147483647`);
  }
  return value;
}

export function databasePoolConfig(
  env: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  return {
    connectionString: env.DATABASE_URL,
    // El presupuesto es compartido entre instancias, revisiones y otros clientes.
    max: positiveInteger(env, 'DATABASE_POOL_MAX', 3),
    connectionTimeoutMillis: positiveInteger(
      env,
      'DATABASE_POOL_CONNECT_TIMEOUT_MS',
      5_000,
    ),
    idleTimeoutMillis: positiveInteger(
      env,
      'DATABASE_POOL_IDLE_TIMEOUT_MS',
      10_000,
    ),
    application_name:
      `parkit-backend${env.K_REVISION ? `:${env.K_REVISION}` : ''}`.slice(
        0,
        63,
      ),
  };
}
