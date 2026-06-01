import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type OnboardingApplication, type User } from '@prisma/client';
import { AuditActions, AuditService } from '../audit/audit.service';
import { SupabaseAuthService } from '../auth/supabase-auth.service';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { CreateCompanyOnboardingDto } from './dto/create-company-onboarding.dto';
import {
  CompanyDocumentDto,
  OnboardingStateDto,
} from './dto/onboarding-response.dto';
import { RegisterDocumentDto } from './dto/register-document.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import {
  declaredBranchesOf,
  toApplicationDto,
  toCompanyDocumentDto,
  toCompanyProfileDto,
} from './onboarding.mappers';

const EDITABLE_STATES = ['draft', 'rejected', 'pending_review'];

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: SupabaseAuthService,
  ) {}

  /** Step 1: create company + draft application. One company per owner. */
  async createCompany(
    user: User,
    dto: CreateCompanyOnboardingDto,
  ): Promise<OnboardingStateDto> {
    const existing = await this.prisma.company.findFirst({
      where: { ownerUserId: user.id },
    });
    if (existing) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        'This owner already has a company',
        '/onboarding/company',
        ErrorCodes.COMPANY_ALREADY_EXISTS,
      );
    }

    // A driver registering their first parking lot becomes an owner. The DB
    // role flips inside the transaction (authorization source of truth); the
    // JWT claim is mirrored right after (best-effort, see below).
    const promoteToOwner = user.role === 'driver';

    const { company, application } = await this.prisma.$transaction(
      async (tx) => {
        const company = await tx.company.create({
          data: {
            legalName: dto.legalName,
            cuit: dto.cuit,
            email: dto.email,
            phone: dto.phone ?? null,
            address: dto.address ?? null,
            status: 'pending',
            ownerUserId: user.id,
          },
        });
        const application = await tx.onboardingApplication.create({
          data: { companyId: company.id, status: 'draft' },
        });
        await tx.auditLog.create({
          data: {
            action: AuditActions.COMPANY_CREATED,
            entityType: 'company',
            entityId: company.id,
            actorUserId: user.id,
            companyId: company.id,
          },
        });
        if (promoteToOwner) {
          await tx.user.update({
            where: { id: user.id },
            data: { role: 'owner' },
          });
          await tx.auditLog.create({
            data: {
              action: AuditActions.OWNER_PROMOTED,
              entityType: 'user',
              entityId: user.id,
              actorUserId: user.id,
              companyId: company.id,
            },
          });
        }
        return { company, application };
      },
    );

    if (promoteToOwner) {
      // Mirror the role into the JWT (`app_metadata.role`) so the client routes
      // as an owner after refreshing the session. Supabase Auth is not
      // transactional with our DB: on failure the DB role still governs
      // authorization, so we only audit a warning instead of failing the call.
      try {
        await this.auth.setUserRole(user.id, 'owner');
      } catch (err) {
        await this.audit.record({
          action: AuditActions.OWNER_PROMOTED,
          entityType: 'user',
          entityId: user.id,
          actorUserId: user.id,
          companyId: company.id,
          severity: 'warn',
          metadata: {
            appMetadataSync: 'failed',
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    return {
      company: toCompanyProfileDto(company),
      application: toApplicationDto(application, 0),
    };
  }

  /** Onboarding state of the authenticated owner (company + latest application). */
  async getMe(user: User): Promise<OnboardingStateDto> {
    const company = await this.prisma.company.findFirst({
      where: { ownerUserId: user.id },
      include: {
        applications: { orderBy: { createdAt: 'desc' }, take: 1 },
        _count: { select: { documents: true } },
      },
    });

    if (!company) {
      return { company: null, application: null };
    }

    const application = company.applications[0] ?? null;
    return {
      company: toCompanyProfileDto(company),
      application: application
        ? toApplicationDto(application, company._count.documents)
        : null,
    };
  }

  /** Edits company data and/or declared branches (only draft/rejected). */
  async updateApplication(
    user: User,
    applicationId: string,
    dto: UpdateApplicationDto,
  ): Promise<OnboardingStateDto> {
    const application = await this.loadOwnedApplication(user, applicationId);
    this.assertEditable(application);

    await this.prisma.$transaction(async (tx) => {
      const companyData: Prisma.CompanyUpdateInput = {};
      if (dto.legalName !== undefined) companyData.legalName = dto.legalName;
      if (dto.cuit !== undefined) companyData.cuit = dto.cuit;
      if (dto.email !== undefined) companyData.email = dto.email;
      if (dto.phone !== undefined) companyData.phone = dto.phone;
      if (dto.address !== undefined) companyData.address = dto.address;
      if (Object.keys(companyData).length > 0) {
        await tx.company.update({
          where: { id: application.companyId },
          data: companyData,
        });
      }

      if (dto.declaredBranches !== undefined) {
        await tx.onboardingApplication.update({
          where: { id: applicationId },
          data: {
            declaredBranches:
              dto.declaredBranches as unknown as Prisma.InputJsonValue,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          action: AuditActions.APPLICATION_UPDATED,
          entityType: 'application',
          entityId: applicationId,
          actorUserId: user.id,
          companyId: application.companyId,
        },
      });
    });

    return this.getMe(user);
  }

  /** Registers metadata for an application document. */
  async addDocument(
    user: User,
    applicationId: string,
    dto: RegisterDocumentDto,
  ): Promise<CompanyDocumentDto> {
    const application = await this.loadOwnedApplication(user, applicationId);
    const doc = await this.prisma.companyDocument.create({
      data: {
        companyId: application.companyId,
        applicationId: application.id,
        name: dto.name,
        storagePath: dto.storagePath,
        mimeType: dto.mimeType ?? null,
      },
    });
    return toCompanyDocumentDto(doc);
  }

  /** Submits the application for review: draft|rejected → pending_review. */
  async submit(user: User, applicationId: string): Promise<OnboardingStateDto> {
    const application = await this.loadOwnedApplication(user, applicationId);
    this.assertEditable(application);

    if (declaredBranchesOf(application).length === 0) {
      throw new FormattedException(
        'Bad Request',
        HttpStatus.BAD_REQUEST,
        'Declare at least one branch before submitting',
        '/onboarding/application/submit',
        ErrorCodes.ONBOARDING_NOT_SUBMITTABLE,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.onboardingApplication.update({
        where: { id: applicationId },
        data: {
          status: 'pending_review',
          submittedAt: new Date(),
          rejectionReason: null,
        },
      });
      await tx.auditLog.create({
        data: {
          action: AuditActions.APPLICATION_SUBMITTED,
          entityType: 'application',
          entityId: applicationId,
          actorUserId: user.id,
          companyId: application.companyId,
        },
      });
    });

    return this.getMe(user);
  }

  private async loadOwnedApplication(
    user: User,
    applicationId: string,
  ): Promise<OnboardingApplication & { company: { ownerUserId: string } }> {
    const application = await this.prisma.onboardingApplication.findUnique({
      where: { id: applicationId },
      include: { company: true },
    });
    if (!application) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Application ${applicationId} not found`,
        '/onboarding/application',
        ErrorCodes.ONBOARDING_APPLICATION_NOT_FOUND,
      );
    }
    if (user.role !== 'admin' && application.company.ownerUserId !== user.id) {
      throw new FormattedException(
        'Forbidden',
        HttpStatus.FORBIDDEN,
        'You are not the owner of this application',
        '/onboarding/application',
        ErrorCodes.COMPANY_NOT_OWNER,
      );
    }
    return application;
  }

  private assertEditable(application: OnboardingApplication): void {
    if (!EDITABLE_STATES.includes(application.status)) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        `Application in state '${application.status}' can no longer be edited`,
        '/onboarding/application',
        ErrorCodes.ONBOARDING_INVALID_STATE,
      );
    }
  }
}
