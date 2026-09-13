import { HttpStatus, Injectable } from '@nestjs/common';
import { MembershipRole } from '@prisma/client';
import type { ApplicationStatus, User } from '@prisma/client';
import { AuditActions } from '../../audit/audit.service';
import { PrismaService } from '../../database/prisma.service';
import type { UpdateEntityAddressDto } from '../../entities/dto/entity-address.dto';
import { withCapacity } from '../../entities/entity-settings';
import {
  addressCreateData,
  readDeclaredAddress,
} from '../../entities/tenant-address';
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

/**
 * Vista tipada del JSON `onboarding_applications.declared_entity`.
 *
 * No hay columnas tipadas atrás: es una columna JSON libre, así que conviven
 * la forma vieja (sólo `address` como string) y la nueva (`location` con los
 * campos separados). Todo opcional por eso mismo. La dirección NO se lee de
 * acá a mano: se lee con `readDeclaredAddress()`, que tolera las dos formas.
 */
interface DeclaredEntity {
  name?: string;
  address?: string;
  location?: UpdateEntityAddressDto;
  legalName?: string;
  cuit?: string;
  email?: string;
  phone?: string;
  totalSpots?: number;
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
   * Aprobación atómica: materializa la entidad declarada como `Tenant` + la
   * membresía `owner` del solicitante, y marca la solicitud aprobada. El rol de
   * entidad vive en `UserMembership.role`; el rol GLOBAL del solicitante sigue
   * siendo `user`, así que no hay claim de JWT que espejar.
   *
   * Los servicios, los tipos de vehículo, el catálogo y los métodos de pago del
   * sistema NO se crean acá: los siembra el trigger `AFTER INSERT ON tenants`
   * (`bootstrap_tenant_defaults()`), que corre dentro de esta misma transacción.
   * Antes se creaban acá y el alta directa por `admin/parkings` se los olvidaba,
   * así que un estacionamiento dado de alta por el panel nacía manco.
   */
  async approve(admin: User, id: string): Promise<ApplicationDto> {
    const application = await this.loadApplication(id);
    this.assertPendingReview(application.status);

    const declared = declaredEntityOf(application);
    const entity = declared as DeclaredEntity;
    const applicant = application.applicant;

    // La dirección declarada se materializa en las COLUMNAS de `tenants`, no
    // en `settings`. Si esto no está, los campos estructurados del wizard se
    // pierden en silencio al aprobar y el dueño no puede vincular Mercado
    // Pago. `readDeclaredAddress` tolera además la forma vieja del JSON (sólo
    // `address` plano), que es lo que tienen los borradores en vuelo.
    const address = readDeclaredAddress(declared);

    await this.prisma.$transaction(async (tx) => {
      // La capacidad declarada se materializa en `tenant.settings.capacity`.
      // Es UN número: las plazas no dependen de la carrocería. Qué vehículos
      // acepta la playa vive en `vehicle_types.accepted`.
      //
      // Se arma con `withCapacity()` y no con el literal `{ capacity }`: el
      // literal PISA el objeto `settings` entero. Hoy no rompe nada porque
      // `capacity` es la única clave, pero el día que haya una segunda este
      // camino la borraría sin avisar. Mismo helper que usa `updateProfile`.
      const settings = withCapacity({}, { total: entity.totalSpots ?? 0 });
      const tenant = await tx.tenant.create({
        data: {
          name: entity.name ?? 'Untitled',
          address: address.formatted,
          ...addressCreateData(address),
          legalName: entity.legalName ?? null,
          cuit: entity.cuit ?? null,
          email: entity.email ?? null,
          phone: entity.phone ?? null,
          status: 'active',
          settings,
        },
      });

      // The applicant becomes the owner of the new entity via UserMembership.
      await tx.userMembership.create({
        data: {
          userId: applicant.id,
          tenantId: tenant.id,
          role: MembershipRole.owner,
        },
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
