import { HttpStatus, Injectable } from '@nestjs/common';
import { MembershipRole } from '@prisma/client';
import type { ApplicationStatus, User } from '@prisma/client';
import { AuditActions } from '../../audit/audit.service';
import { PrismaService } from '../../database/prisma.service';
import { declaredEntityOf } from '../../onboarding/onboarding.mappers';
import {
  APPLICATION_DOCUMENTS_BUCKET,
  StorageService,
} from '../../storage/storage.service';
import { ErrorCodes } from '../../utils/exceptions/error-codes';
import { FormattedException } from '../../utils/exceptions/http-exception/formatted-exeption';
import {
  APPLICATION_DETAIL_INCLUDE,
  APPLICATION_LIST_INCLUDE,
  toApplicationDetailDto,
  toApplicationDto,
  toInternalStatus,
} from './applications.mappers';
import { ApplicationDetailDto, ApplicationDto } from './dto/application.dto';
import { DocumentSignedUrlDto } from './dto/document-signed-url.dto';
import type { DocumentDisposition } from './dto/document-signed-url-query.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
import { RejectApplicationDto } from './dto/reject-application.dto';

/** Validity window of a document signed URL, in seconds (5 minutes). */
const DOCUMENT_SIGNED_URL_TTL = 300;

interface DeclaredEntity {
  name?: string;
  address?: string;
  legalName?: string;
  cuit?: string;
  email?: string;
  phone?: string;
  carSpots?: number;
  motorcycleSpots?: number;
  bicycleSpots?: number;
}

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async list(query: ListApplicationsQueryDto): Promise<ApplicationDto[]> {
    const nonDraft: ApplicationStatus[] = [
      'pending_review',
      'approved',
      'rejected',
    ];
    const where = query.status
      ? { status: toInternalStatus(query.status) }
      : { status: { in: nonDraft } };

    const apps = await this.prisma.onboardingApplication.findMany({
      where,
      include: APPLICATION_LIST_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return apps.map(toApplicationDto);
  }

  async getDetail(id: string): Promise<ApplicationDetailDto> {
    const app = await this.prisma.onboardingApplication.findUnique({
      where: { id },
      include: APPLICATION_DETAIL_INCLUDE,
    });
    if (!app) {
      throw this.notFound(id);
    }
    return toApplicationDetailDto(app);
  }

  /**
   * Mints a short-lived signed URL so an Ops reviewer can preview or download a
   * document the applicant uploaded to the private storage bucket. The
   * service-role storage client bypasses the per-owner bucket RLS.
   */
  async getDocumentSignedUrl(
    applicationId: string,
    documentId: string,
    disposition: DocumentDisposition = 'inline',
  ): Promise<DocumentSignedUrlDto> {
    const document = await this.prisma.applicationDocument.findFirst({
      where: { id: documentId, applicationId },
    });
    if (!document) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Document ${documentId} not found for application ${applicationId}`,
        '/admin/applications',
        ErrorCodes.ONBOARDING_DOCUMENT_NOT_FOUND,
      );
    }

    const url = await this.storage.createSignedUrl(
      APPLICATION_DOCUMENTS_BUCKET,
      document.storagePath,
      DOCUMENT_SIGNED_URL_TTL,
      disposition === 'attachment' ? { download: document.name } : undefined,
    );

    return { url, expiresIn: DOCUMENT_SIGNED_URL_TTL };
  }

  /**
   * Atomic approval: materializes the declared entity as a `Tenant` (+ initial
   * zone + applicant `owner` membership + system payment methods) and marks the
   * application approved. The entity-level role (owner) lives on
   * `UserMembership.role`; the applicant's GLOBAL role stays `user`, so there is
   * no JWT claim to mirror.
   */
  async approve(admin: User, id: string): Promise<ApplicationDto> {
    const application = await this.loadApplication(id);
    this.assertPendingReview(application.status);

    const entity = declaredEntityOf(application) as DeclaredEntity;
    const applicant = application.applicant;

    await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: entity.name ?? 'Untitled',
          address: entity.address ?? null,
          legalName: entity.legalName ?? null,
          cuit: entity.cuit ?? null,
          email: entity.email ?? null,
          phone: entity.phone ?? null,
          status: 'active',
        },
      });

      const carSpots = entity.carSpots ?? 0;
      const motorcycleSpots = entity.motorcycleSpots ?? 0;
      const bicycleSpots = entity.bicycleSpots ?? 0;
      if (carSpots + motorcycleSpots + bicycleSpots > 0) {
        await tx.zone.create({
          data: {
            tenantId: tenant.id,
            name: 'General',
            carSpots,
            motorcycleSpots,
            bicycleSpots,
          },
        });
      }

      // The applicant becomes the owner of the new entity via UserMembership.
      await tx.userMembership.create({
        data: {
          userId: applicant.id,
          tenantId: tenant.id,
          role: MembershipRole.owner,
        },
      });

      // System payment methods (non-deletable, can be disabled).
      await tx.paymentMethod.createMany({
        data: [
          {
            tenantId: tenant.id,
            type: 'mp_transfer',
            name: 'Transfer (Mercado Pago)',
            enabled: true,
            isSystem: true,
            isDefault: true,
          },
          {
            tenantId: tenant.id,
            type: 'cash',
            name: 'Cash',
            enabled: true,
            isSystem: true,
            isDefault: false,
          },
        ],
      });

      await tx.onboardingApplication.update({
        where: { id },
        data: {
          status: 'approved',
          reviewedAt: new Date(),
          reviewedBy: admin.id,
          tenantId: tenant.id,
        },
      });

      await tx.auditLog.create({
        data: {
          action: AuditActions.ENTITY_APPROVED,
          entityType: 'tenant',
          entityId: tenant.id,
          actorUserId: admin.id,
          tenantId: tenant.id,
        },
      });
    });

    return this.getById(id);
  }

  async reject(
    admin: User,
    id: string,
    dto: RejectApplicationDto,
  ): Promise<ApplicationDto> {
    const application = await this.loadApplication(id);
    this.assertPendingReview(application.status);

    await this.prisma.$transaction(async (tx) => {
      await tx.onboardingApplication.update({
        where: { id },
        data: {
          status: 'rejected',
          rejectionReason: dto.reason,
          reviewedAt: new Date(),
          reviewedBy: admin.id,
        },
      });
      await tx.auditLog.create({
        data: {
          action: AuditActions.ENTITY_REJECTED,
          entityType: 'application',
          entityId: id,
          actorUserId: admin.id,
          metadata: { reason: dto.reason },
        },
      });
    });

    return this.getById(id);
  }

  private async getById(id: string): Promise<ApplicationDto> {
    const app = await this.prisma.onboardingApplication.findUnique({
      where: { id },
      include: APPLICATION_LIST_INCLUDE,
    });
    if (!app) {
      throw this.notFound(id);
    }
    return toApplicationDto(app);
  }

  private async loadApplication(id: string) {
    const app = await this.prisma.onboardingApplication.findUnique({
      where: { id },
      include: { applicant: true },
    });
    if (!app) {
      throw this.notFound(id);
    }
    return app;
  }

  private assertPendingReview(status: string): void {
    if (status !== 'pending_review') {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        `Application in state '${status}' cannot be reviewed`,
        '/admin/applications',
        ErrorCodes.ONBOARDING_INVALID_STATE,
      );
    }
  }

  private notFound(id: string): FormattedException {
    return new FormattedException(
      'Not Found',
      HttpStatus.NOT_FOUND,
      `Application ${id} not found`,
      '/admin/applications',
      ErrorCodes.ONBOARDING_APPLICATION_NOT_FOUND,
    );
  }
}
