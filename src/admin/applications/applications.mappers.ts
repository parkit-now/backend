import type { ApplicationStatus, Prisma } from '@prisma/client';
import {
  declaredBranchesOf,
  toCompanyDocumentDto,
} from '../../onboarding/onboarding.mappers';
import { ApplicationDetailDto, ApplicationDto } from './dto/application.dto';
import type { ApplicationStatusFilter } from './dto/list-applications-query.dto';

/** Internal `application_status` → front contract. */
export function toExternalStatus(
  status: ApplicationStatus,
): ApplicationStatusFilter {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    default:
      // pending_review (and draft, defensively) are exposed as 'pending'.
      return 'pending';
  }
}

/** Front contract → `application_status` filter. */
export function toInternalStatus(
  status: ApplicationStatusFilter,
): ApplicationStatus {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    default:
      return 'pending_review';
  }
}

export const APPLICATION_LIST_INCLUDE = {
  company: { include: { owner: true } },
  _count: { select: { documents: true } },
} satisfies Prisma.OnboardingApplicationInclude;

export const APPLICATION_DETAIL_INCLUDE = {
  company: { include: { owner: true } },
  documents: { orderBy: { createdAt: 'asc' } },
  _count: { select: { documents: true } },
} satisfies Prisma.OnboardingApplicationInclude;

type ApplicationPayload = Prisma.OnboardingApplicationGetPayload<{
  include: typeof APPLICATION_LIST_INCLUDE;
}>;

type ApplicationDetailPayload = Prisma.OnboardingApplicationGetPayload<{
  include: typeof APPLICATION_DETAIL_INCLUDE;
}>;

export function toApplicationDto(app: ApplicationPayload): ApplicationDto {
  return {
    id: app.id,
    legalName: app.company.legalName,
    ownerEmail: app.company.owner.email,
    email: app.company.email,
    cuit: app.company.cuit,
    branchCount: declaredBranchesOf(app).length,
    docsCount: app._count.documents,
    status: toExternalStatus(app.status),
    submittedAt: app.submittedAt ? app.submittedAt.toISOString() : null,
    createdAt: app.createdAt.toISOString(),
  };
}

export function toApplicationDetailDto(
  app: ApplicationDetailPayload,
): ApplicationDetailDto {
  return {
    ...toApplicationDto(app),
    phone: app.company.phone,
    address: app.company.address,
    declaredBranches: declaredBranchesOf(app),
    rejectionReason: app.rejectionReason,
    reviewedAt: app.reviewedAt ? app.reviewedAt.toISOString() : null,
    documents: app.documents.map(toCompanyDocumentDto),
  };
}
