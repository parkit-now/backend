import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { GoogleOidcService } from './google-oidc.service';
import { SchedulerOidcGuard } from './scheduler-oidc.guard';

const AUDIENCE = 'https://backend.example.run.app';
const INVOKER = 'scheduler@parkit.iam.gserviceaccount.com';

const oidc = { verify: jest.fn() };
const config = { get: jest.fn() };

const guard = new SchedulerOidcGuard(
  config as unknown as ConfigService,
  oidc as unknown as GoogleOidcService,
);

function contextWith(authorization?: string): ExecutionContext {
  const request = {
    url: '/internal/jobs/lpr-image-retention',
    headers: { authorization },
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function configure(values: Record<string, string | undefined>) {
  config.get.mockImplementation((key: string) => values[key]);
}

async function expectRejection(
  promise: Promise<unknown>,
  status: HttpStatus,
  code: string,
) {
  // eslint-disable-next-line @typescript-eslint/await-thenable
  await expect(promise).rejects.toBeInstanceOf(FormattedException);
  // eslint-disable-next-line @typescript-eslint/await-thenable
  await expect(promise).rejects.toMatchObject({
    status,
    response: expect.objectContaining({ code }) as unknown,
  });
}

describe('SchedulerOidcGuard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configure({
      INTERNAL_JOBS_AUDIENCE: AUDIENCE,
      INTERNAL_JOBS_INVOKER_EMAIL: INVOKER,
    });
    oidc.verify.mockResolvedValue({ email: INVOKER, email_verified: true });
  });

  it('deja pasar un token de Google emitido para la audiencia y la service account configuradas', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(guard.canActivate(contextWith('Bearer tok'))).resolves.toBe(
      true,
    );
    expect(oidc.verify).toHaveBeenCalledWith('tok', AUDIENCE);
  });

  it('sin configurar, el endpoint no existe: 404 y ni mira el token', async () => {
    configure({ INTERNAL_JOBS_AUDIENCE: AUDIENCE });
    await expectRejection(
      guard.canActivate(contextWith('Bearer tok')),
      HttpStatus.NOT_FOUND,
      ErrorCodes.NOT_FOUND,
    );
    configure({ INTERNAL_JOBS_INVOKER_EMAIL: INVOKER });
    await expectRejection(
      guard.canActivate(contextWith('Bearer tok')),
      HttpStatus.NOT_FOUND,
      ErrorCodes.NOT_FOUND,
    );
    expect(oidc.verify).not.toHaveBeenCalled();
  });

  it('401 sin bearer token', async () => {
    await expectRejection(
      guard.canActivate(contextWith(undefined)),
      HttpStatus.UNAUTHORIZED,
      ErrorCodes.AUTH_MISSING_TOKEN,
    );
    await expectRejection(
      guard.canActivate(contextWith('Basic abc')),
      HttpStatus.UNAUTHORIZED,
      ErrorCodes.AUTH_MISSING_TOKEN,
    );
    expect(oidc.verify).not.toHaveBeenCalled();
  });

  it('401 si el token no verifica (firma, emisor, audiencia o vencimiento)', async () => {
    oidc.verify.mockRejectedValue(new Error('signature verification failed'));
    await expectRejection(
      guard.canActivate(contextWith('Bearer malo')),
      HttpStatus.UNAUTHORIZED,
      ErrorCodes.UNAUTHORIZED,
    );
  });

  it('403 si el token es válido pero de otra cuenta, o con el email sin verificar', async () => {
    oidc.verify.mockResolvedValue({
      email: 'otra@proyecto-ajeno.iam.gserviceaccount.com',
      email_verified: true,
    });
    await expectRejection(
      guard.canActivate(contextWith('Bearer tok')),
      HttpStatus.FORBIDDEN,
      ErrorCodes.FORBIDDEN,
    );

    oidc.verify.mockResolvedValue({ email: INVOKER, email_verified: false });
    await expectRejection(
      guard.canActivate(contextWith('Bearer tok')),
      HttpStatus.FORBIDDEN,
      ErrorCodes.FORBIDDEN,
    );

    oidc.verify.mockResolvedValue({});
    await expectRejection(
      guard.canActivate(contextWith('Bearer tok')),
      HttpStatus.FORBIDDEN,
      ErrorCodes.FORBIDDEN,
    );
  });
});
