import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { ApplicationStatus, User } from '@prisma/client';
import { AuditActions, AuditService } from '../../audit/audit.service';
import { SupabaseAuthService } from '../../auth/supabase-auth.service';
import { PrismaService } from '../../database/prisma.service';
import { declaredBranchesOf } from '../../onboarding/onboarding.mappers';
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

interface DeclaredBranch {
  name: string;
  address?: string;
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
   * Atomic approval: activates the company, materializes the declared
   * branches as tenants (+ initial zone + owner membership), creates the
   * system payment methods and marks the application as approved. Writing
   * `app_metadata.tenant_id` (Supabase Auth) happens OUTSIDE the transaction.
   */
  async approve(admin: User, id: string): Promise<ApplicationDto> {
    const application = await this.loadApplication(id);
    this.assertPendingReview(application.status);

    const branches = declaredBranchesOf(application) as DeclaredBranch[];

    const { ownerUserId, companyId, createdTenantIds } =
      await this.prisma.$transaction(async (tx) => {
        const company = await tx.company.update({
          where: { id: application.companyId },
          data: { status: 'active' },
        });

        const createdTenantIds: string[] = [];
        for (const branch of branches) {
          const tenant = await tx.tenant.create({
            data: {
              name: branch.name,
              address: branch.address ?? null,
              status: 'active',
              companyId: company.id,
            },
          });
          createdTenantIds.push(tenant.id);

          const carSpots = branch.carSpots ?? 0;
          const motorcycleSpots = branch.motorcycleSpots ?? 0;
          const bicycleSpots = branch.bicycleSpots ?? 0;
          if (carSpots + motorcycleSpots + bicycleSpots > 0) {
            // Materializes the declared counts as an initial zone. Accessed via
            // the base client (admin provisioning), with an explicit tenantId.
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

          // Reuses UserMembership to grant the owner access to their branch.
          await tx.userMembership.create({
            data: { userId: company.ownerUserId, tenantId: tenant.id },
          });
        }

        // System payment methods (non-deletable, can be disabled).
        await tx.paymentMethod.createMany({
          data: [
            {
              companyId: company.id,
              type: 'mp_transfer',
              name: 'Transfer (Mercado Pago)',
              enabled: true,
              isSystem: true,
              isDefault: true,
            },
            {
              companyId: company.id,
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
          },
        });

        await tx.auditLog.create({
          data: {
            action: AuditActions.COMPANY_APPROVED,
            entityType: 'company',
            entityId: company.id,
            actorUserId: admin.id,
            companyId: company.id,
            metadata: { tenantsCreated: createdTenantIds },
          },
        });

        return {
          ownerUserId: company.ownerUserId,
          companyId: company.id,
          createdTenantIds,
        };
      });

    // Outside the transaction: Supabase Auth is not transactional with the DB.
    const firstTenantId = createdTenantIds[0];
    if (firstTenantId) {
      try {
        await this.auth.setActiveTenant(ownerUserId, firstTenantId);
      } catch (err) {
        this.logger.warn(
          `Approved company ${companyId} but failed to set active tenant`,
          err instanceof Error ? err.stack : String(err),
        );
        await this.audit.record({
          action: AuditActions.APPLICATION_ACTIVE_TENANT_FAILED,
          entityType: 'company',
          entityId: companyId,
          actorUserId: admin.id,
          companyId,
          severity: 'warn',
          metadata: { error: err instanceof Error ? err.message : String(err) },
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
          action: AuditActions.APPLICATION_REJECTED,
          entityType: 'application',
          entityId: id,
          actorUserId: admin.id,
          companyId: application.companyId,
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
      include: { company: true },
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
