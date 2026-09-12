import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MetricsWindowQueryDto } from './metrics-window-query.dto';

/**
 * The constraint names that failed, per property — exactly what the global
 * pipe turns into `validationsErrors[].code`. Same options as `main.ts`, so an
 * undeclared parameter fails here the way it fails over HTTP.
 */
async function failures(
  query: Record<string, unknown>,
): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(MetricsWindowQueryDto, query), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return Object.fromEntries(
    errors.map((error) => [
      error.property,
      Object.keys(error.constraints ?? {}),
    ]),
  );
}

const WINDOW = {
  from: '2026-09-01T00:00:00-03:00',
  to: '2026-09-08T00:00:00-03:00',
};

/** UUIDv7, the version the desktop generates for its cash sessions. */
const SESSION = '0198f2a4-7c3e-7a1b-9d2e-4f5a6b7c8d9e';

describe('MetricsWindowQueryDto', () => {
  it('accepts a plain window', async () => {
    expect(await failures(WINDOW)).toEqual({});
  });

  it('still requires both bounds without a cash session', async () => {
    expect(await failures({})).toEqual({
      from: ['isOffsetDateTime'],
      to: ['isOffsetDateTime'],
    });
  });

  it('lets a cash session stand in for the window', async () => {
    expect(await failures({ cashSessionId: SESSION })).toEqual({});
  });

  it('still validates a bound sent alongside a session', async () => {
    // A naive date-time is a 400 with or without a session: the session only
    // makes the bound optional, it does not relax what a present one must be.
    expect(
      await failures({ cashSessionId: SESSION, from: '2026-09-01T00:00:00' }),
    ).toEqual({ from: ['isOffsetDateTime'] });
  });

  it('rejects a malformed session id', async () => {
    expect(await failures({ ...WINDOW, cashSessionId: 'caja-1' })).toEqual({
      cashSessionId: ['isUuid'],
    });
  });
});
