import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { defer, Observable } from 'rxjs';
import { TenantContextService } from './tenant-context.service';

/**
 * Interceptor that extracts the tenantId from the request parameters
 * and initializes the TenantContextService for the duration of the request.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(private readonly tenantContext: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const tenantId = request.params.tenantId;

    if (tenantId && typeof tenantId === 'string') {
      // We wrap the rest of the request lifecycle in the ALS context using defer
      // to ensure the subscription is handled correctly by NestJS and RxJS.
      return defer(() =>
        this.tenantContext.runWithTenant(tenantId, () => next.handle()),
      );
    }

    return next.handle();
  }
}
