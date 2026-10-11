import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { GoogleOidcService } from './google-oidc.service';

/**
 * Deja pasar sólo a Cloud Scheduler.
 *
 * El servicio de Cloud Run es público (lo usan la web, el desktop y la app),
 * así que estos endpoints no se pueden proteger con IAM: los protege este
 * guard, que exige un ID token de Google emitido para NUESTRA audiencia
 * (`INTERNAL_JOBS_AUDIENCE`) y para LA service account del job
 * (`INTERNAL_JOBS_INVOKER_EMAIL`). No hay secreto compartido que guardar ni
 * rotar: la firma la valida Google.
 *
 * Sin esas dos variables los endpoints no existen (404): es el estado en local
 * y en cualquier entorno donde no se haya configurado el Scheduler.
 */
@Injectable()
export class SchedulerOidcGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly oidc: GoogleOidcService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const audience = this.config.get<string>('INTERNAL_JOBS_AUDIENCE');
    const invoker = this.config.get<string>('INTERNAL_JOBS_INVOKER_EMAIL');
    if (!audience || !invoker) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        'Not found.',
        request.url,
        ErrorCodes.NOT_FOUND,
      );
    }

    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new FormattedException(
        'Unauthorized',
        HttpStatus.UNAUTHORIZED,
        'Missing bearer token',
        request.url,
        ErrorCodes.AUTH_MISSING_TOKEN,
      );
    }

    let email: string | undefined;
    let emailVerified: boolean | undefined;
    try {
      const payload = await this.oidc.verify(token, audience);
      email = payload.email;
      emailVerified = payload.email_verified;
    } catch {
      throw new FormattedException(
        'Unauthorized',
        HttpStatus.UNAUTHORIZED,
        'Invalid or expired token',
        request.url,
        ErrorCodes.UNAUTHORIZED,
      );
    }

    // Un token válido de Google para esta audiencia pero de OTRA cuenta no
    // alcanza: cualquier service account del mundo puede pedir uno.
    if (email !== invoker || emailVerified !== true) {
      throw new FormattedException(
        'Forbidden',
        HttpStatus.FORBIDDEN,
        'Caller is not allowed to run internal jobs.',
        request.url,
        ErrorCodes.FORBIDDEN,
      );
    }
    return true;
  }
}
