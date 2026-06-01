import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type OnboardingApplication, type User } from '@prisma/client';
import { AuditActions, AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { CreateApplicationDto } from './dto/create-application.dto';
import {
  ApplicationDocumentDto,
  OnboardingApplicationDto,
} from './dto/onboarding-response.dto';
import { RegisterDocumentDto } from './dto/register-document.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import {
  declaredEntityOf,
  toApplicationDocumentDto,
  toApplicationDto,
} from './onboarding.mappers';

const EDITABLE_STATES = ['draft', 'rejected'];

type ApplicationWithDocCount = OnboardingApplication & {
  _count: { documents: number };
};

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Creates a draft application for the current user declaring one entity. */
  async create(
    user: User,
    dto: CreateApplicationDto,
  ): Promise<OnboardingApplicationDto> {
    const application = await this.prisma.onboardingApplication.create({
      data: {
        applicantUserId: user.id,
        status: 'draft',
        declaredEntity: this.toDeclaredEntity(dto),
      },
    });
    await this.audit.record({
      action: AuditActions.APPLICATION_CREATED,
      entityType: 'application',
      entityId: application.id,
      actorUserId: user.id,
    });
    return toApplicationDto(application, 0);
  }

  /** Lists the applications of the current user, newest first. */
  async list(user: User): Promise<OnboardingApplicationDto[]> {
    const apps = await this.prisma.onboardingApplication.findMany({
      where: { applicantUserId: user.id },
      include: { _count: { select: { documents: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return apps.map((app) => toApplicationDto(app, app._count.documents));
  }

  /** Returns a single application owned by the current user. */
  async getOne(
    user: User,
    applicationId: string,
  ): Promise<OnboardingApplicationDto> {
    const application = await this.loadOwnedApplication(user, applicationId);
    return toApplicationDto(application, application._count.documents);
  }

  /** Edits the declared entity (only draft/rejected). */
  async update(
    user: User,
    applicationId: string,
    dto: UpdateApplicationDto,
  ): Promise<OnboardingApplicationDto> {
    const application = await this.loadOwnedApplication(user, applicationId);
    this.assertEditable(application);

    const merged = { ...declaredEntityOf(application), ...this.cleanDto(dto) };

    const updated = await this.prisma.onboardingApplication.update({
      where: { id: applicationId },
      data: { declaredEntity: merged as Prisma.InputJsonValue },
      include: { _count: { select: { documents: true } } },
    });
    await this.audit.record({
      action: AuditActions.APPLICATION_UPDATED,
      entityType: 'application',
      entityId: applicationId,
      actorUserId: user.id,
    });
    return toApplicationDto(updated, updated._count.documents);
  }

  /** Registers metadata for an application document. */
  async addDocument(
    user: User,
    applicationId: string,
    dto: RegisterDocumentDto,
  ): Promise<ApplicationDocumentDto> {
    const application = await this.loadOwnedApplication(user, applicationId);
    const doc = await this.prisma.applicationDocument.create({
      data: {
        applicationId: application.id,
        name: dto.name,
        storagePath: dto.storagePath,
        mimeType: dto.mimeType ?? null,
      },
    });
    await this.audit.record({
      action: AuditActions.APPLICATION_DOCUMENT_ADDED,
      entityType: 'application',
      entityId: application.id,
      actorUserId: user.id,
    });
    return toApplicationDocumentDto(doc);
  }

  /** Submits the application for review: draft|rejected → pending_review. */
  async submit(
    user: User,
    applicationId: string,
  ): Promise<OnboardingApplicationDto> {
    const application = await this.loadOwnedApplication(user, applicationId);
    this.assertEditable(application);

    const updated = await this.prisma.onboardingApplication.update({
      where: { id: applicationId },
      data: {
        status: 'pending_review',
        submittedAt: new Date(),
        rejectionReason: null,
      },
      include: { _count: { select: { documents: true } } },
    });
    await this.audit.record({
      action: AuditActions.APPLICATION_SUBMITTED,
      entityType: 'application',
      entityId: applicationId,
      actorUserId: user.id,
    });
    return toApplicationDto(updated, updated._count.documents);
  }

  private toDeclaredEntity(
    dto: CreateApplicationDto | UpdateApplicationDto,
  ): Prisma.InputJsonValue {
    return this.cleanDto(dto) as Prisma.InputJsonValue;
  }

  /** Drops `undefined` keys so a partial patch does not overwrite with null. */
  private cleanDto(
    dto: CreateApplicationDto | UpdateApplicationDto,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined),
    );
  }

  private async loadOwnedApplication(
    user: User,
    applicationId: string,
  ): Promise<ApplicationWithDocCount> {
    const application = await this.prisma.onboardingApplication.findUnique({
      where: { id: applicationId },
      include: { _count: { select: { documents: true } } },
    });
    if (!application) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Application ${applicationId} not found`,
        '/onboarding/applications',
        ErrorCodes.ONBOARDING_APPLICATION_NOT_FOUND,
      );
    }
    if (user.role !== 'admin' && application.applicantUserId !== user.id) {
      throw new FormattedException(
        'Forbidden',
        HttpStatus.FORBIDDEN,
        'You are not the applicant of this application',
        '/onboarding/applications',
        ErrorCodes.ENTITY_NOT_OWNER,
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
        '/onboarding/applications',
        ErrorCodes.ONBOARDING_INVALID_STATE,
      );
    }
  }
}
