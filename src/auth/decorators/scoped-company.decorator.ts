import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Company } from '@prisma/client';
import type { CompanyScopedRequest } from '../guards/company-owner.guard';

/**
 * Returns the `Company` row attached to the request by `CompanyOwnerGuard`.
 * Use only on routes guarded by `CompanyOwnerGuard` (those with `:companyId`).
 */
export const ScopedCompany = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Company => {
    return ctx.switchToHttp().getRequest<CompanyScopedRequest>().company;
  },
);
