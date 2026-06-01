import type { ApplicationStatus, Prisma } from '@prisma/client';
import {
  declaredEntityOf,
  toApplicationDocumentDto,
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
  applicant: true,
  _count: { select: { documents: true } },
} satisfies Prisma.OnboardingApplicationInclude;

export const APPLICATION_DETAIL_INCLUDE = {
  applicant: true,
  documents: { orderBy: { createdAt: 'asc' } },
  _count: { select: { documents: true } },
} satisfies Prisma.OnboardingApplicationInclude;

type ApplicationPayload = Prisma.OnboardingApplicationGetPayload<{
  include: typeof APPLICATION_LIST_INCLUDE;
}>;

type ApplicationDetailPayload = Prisma.OnboardingApplicationGetPayload<{
  include: typeof APPLICATION_DETAIL_INCLUDE;
}>;

function declaredString(
  entity: Record<string, unknown>,
  key: string,
): string | null {
  const value = entity[key];
  return typeof value === 'string' ? value : null;
}

export function toApplicationDto(app: ApplicationPayload): ApplicationDto {
  const entity = declaredEntityOf(app);
  return {
    id: app.id,
    name: declaredString(entity, 'name') ?? '',
    legalName: declaredString(entity, 'legalName') ?? '',
    applicantEmail: app.applicant.email,
    email: declaredString(entity, 'email') ?? '',
    cuit: declaredString(entity, 'cuit') ?? '',
    docsCount: app._count.documents,
    status: toExternalStatus(app.status),
    submittedAt: app.submittedAt ? app.submittedAt.toISOString() : null,
    createdAt: app.createdAt.toISOString(),
  };
}

export function toApplicationDetailDto(
  app: ApplicationDetailPayload,
): ApplicationDetailDto {
  const entity = declaredEntityOf(app);
  return {
    ...toApplicationDto(app),
    phone: declaredString(entity, 'phone'),
    address: declaredString(entity, 'address'),
    declaredEntity: entity,
    tenantId: app.tenantId,
    rejectionReason: app.rejectionReason,
    reviewedAt: app.reviewedAt ? app.reviewedAt.toISOString() : null,
    documents: app.documents.map(toApplicationDocumentDto),
  };
}
