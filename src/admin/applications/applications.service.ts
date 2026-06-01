import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { ApplicationStatus, User } from '@prisma/client';
import { AuditActions, AuditService } from '../../audit/audit.service';
import { SupabaseAuthService } from '../../auth/supabase-auth.service';
import { PrismaService } from '../../database/prisma.service';
import { declaredEntityOf } from '../../onboarding/onboarding.mappers';
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
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
import { RejectApplicationDto } from './dto/reject-application.dto';

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
  private readonly logger = new Logger(ApplicationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: SupabaseAuthService,
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
   * Atomic approval: materializes the declared entity as a `Tenant` (+ initial
   * zone + applicant membership + system payment methods), marks the
   * application approved and promotes a `driver` applicant to `owner`. The DB
   * role change is the authorization source of truth; the JWT role claim is
   * mirrored OUTSIDE the transaction (best-effort).
   */
  async approve(admin: User, id: string): Promise<ApplicationDto> {
    const application = await this.loadApplication(id);
    this.assertPendingReview(application.status);

    const entity = declaredEntityOf(application) as DeclaredEntity;
    const applicant = application.applicant;
    const promoteToOwner = applicant.role === 'driver';

    const { tenantId } = await this.prisma.$transaction(async (tx) => {
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

      // The applicant gains access to the entity via UserMembership.
      await tx.userMembership.create({
        data: { userId: applicant.id, tenantId: tenant.id },
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

      if (promoteToOwner) {
        await tx.user.update({
          where: { id: applicant.id },
          data: { role: 'owner' },
        });
        await tx.auditLog.create({
          data: {
            action: AuditActions.OWNER_PROMOTED,
            entityType: 'user',
            entityId: applicant.id,
            actorUserId: admin.id,
            tenantId: tenant.id,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          action: AuditActions.ENTITY_APPROVED,
          entityType: 'tenant',
          entityId: tenant.id,
          actorUserId: admin.id,
          tenantId: tenant.id,
        },
      });

      return { tenantId: tenant.id };
    });

    // Outside the transaction: Supabase Auth is not transactional with the DB.
    if (promoteToOwner) {
      try {
        await this.auth.setUserRole(applicant.id, 'owner');
      } catch (err) {
        this.logger.warn(
          `Approved entity ${tenantId} but failed to mirror owner role`,
          err instanceof Error ? err.stack : String(err),
        );
        await this.audit.record({
          action: AuditActions.OWNER_PROMOTED,
          entityType: 'user',
          entityId: applicant.id,
          actorUserId: admin.id,
          tenantId,
          severity: 'warn',
          metadata: {
            appMetadataSync: 'failed',
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

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
