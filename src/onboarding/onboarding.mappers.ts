import type {
  ApplicationDocument,
  OnboardingApplication,
} from '@prisma/client';
import {
  ApplicationDocumentDto,
  OnboardingApplicationDto,
} from './dto/onboarding-response.dto';

export function declaredEntityOf(
  app: OnboardingApplication,
): Record<string, unknown> {
  const entity = app.declaredEntity;
  return entity && typeof entity === 'object' && !Array.isArray(entity)
    ? entity
    : {};
}

export function toApplicationDto(
  app: OnboardingApplication,
  docsCount: number,
): OnboardingApplicationDto {
  return {
    id: app.id,
    status: app.status,
    declaredEntity: declaredEntityOf(app),
    docsCount,
    tenantId: app.tenantId,
    submittedAt: app.submittedAt ? app.submittedAt.toISOString() : null,
    reviewedAt: app.reviewedAt ? app.reviewedAt.toISOString() : null,
    rejectionReason: app.rejectionReason,
    createdAt: app.createdAt.toISOString(),
  };
}

export function toApplicationDocumentDto(
  doc: ApplicationDocument,
): ApplicationDocumentDto {
  return {
    id: doc.id,
    name: doc.name,
    storagePath: doc.storagePath,
    mimeType: doc.mimeType,
    createdAt: doc.createdAt.toISOString(),
  };
}
