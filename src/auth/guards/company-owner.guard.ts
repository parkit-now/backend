import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Company } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ErrorCodes } from '../../utils/exceptions/error-codes';
import { FormattedException } from '../../utils/exceptions/http-exception/formatted-exeption';
import type { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * `request.company` shape after this guard succeeds: the `Company` row whose
 * `:companyId` is in the route, already verified to belong to the
 * authenticated owner (or accessed by an admin).
 */
export interface CompanyScopedRequest extends AuthenticatedRequest {
  company: Company;
}

/**
 * Guard that verifies the authenticated user owns the company referenced by the
 * route `:companyId`. Prevents IDOR on company-level resources.
 *
 * Modeled on `TenantMembershipGuard`: admins (PARKIT Ops) have global access.
 * The resolved company is attached to `request.company` to avoid a second fetch
 * in the service.
 */
@Injectable()
export class CompanyOwnerGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<CompanyScopedRequest>();
    const user = request.user;
    const companyId = request.params.companyId;

    if (!user) {
      throw new FormattedException(
        'Unauthorized',
        HttpStatus.UNAUTHORIZED,
        'User is not authenticated',
        request.url,
        ErrorCodes.UNAUTHORIZED,
      );
    }

    if (!companyId || typeof companyId !== 'string') {
      // Fail closed: route misconfigured for company-level validation.
      throw new FormattedException(
        'Forbidden',
        HttpStatus.FORBIDDEN,
        'Missing companyId in request parameters',
        request.url,
        ErrorCodes.FORBIDDEN,
      );
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    });

    if (!company) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Company ${companyId} not found`,
        request.url,
        ErrorCodes.COMPANY_NOT_FOUND,
      );
    }

    if (user.role !== 'admin' && company.ownerUserId !== user.id) {
      throw new FormattedException(
        'Forbidden',
        HttpStatus.FORBIDDEN,
        'You are not the owner of this company',
        request.url,
        ErrorCodes.COMPANY_NOT_OWNER,
      );
    }

    request.company = company;
    return true;
  }
}
