import type {
  Company,
  CompanyDocument,
  OnboardingApplication,
} from '@prisma/client';
import { CompanyProfileDto } from './dto/company-profile.dto';
import {
  CompanyDocumentDto,
  OnboardingApplicationDto,
} from './dto/onboarding-response.dto';

export function toCompanyProfileDto(company: Company): CompanyProfileDto {
  return {
    id: company.id,
    legalName: company.legalName,
    cuit: company.cuit,
    email: company.email,
    phone: company.phone,
    address: company.address,
    status: company.status,
    createdAt: company.createdAt.toISOString(),
  };
}

export function declaredBranchesOf(app: OnboardingApplication): unknown[] {
  return Array.isArray(app.declaredBranches) ? app.declaredBranches : [];
}

export function toApplicationDto(
  app: OnboardingApplication,
  docsCount: number,
): OnboardingApplicationDto {
  const branches = declaredBranchesOf(app);
  return {
    id: app.id,
    status: app.status,
    declaredBranches: branches,
    declaredBranchCount: branches.length,
    docsCount,
    submittedAt: app.submittedAt ? app.submittedAt.toISOString() : null,
    reviewedAt: app.reviewedAt ? app.reviewedAt.toISOString() : null,
    rejectionReason: app.rejectionReason,
    createdAt: app.createdAt.toISOString(),
  };
}

export function toCompanyDocumentDto(doc: CompanyDocument): CompanyDocumentDto {
  return {
    id: doc.id,
    name: doc.name,
    storagePath: doc.storagePath,
    mimeType: doc.mimeType,
    createdAt: doc.createdAt.toISOString(),
  };
}
