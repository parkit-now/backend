import { HttpStatus, Injectable } from '@nestjs/common';
import {
  LprDetectionEvent,
  LprDetectionStatus,
  Prisma,
  User,
} from '@prisma/client';
import { AuditActions, AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import {
  LPR_DETECTION_IMAGES_BUCKET,
  StorageService,
} from '../storage/storage.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { LprDetectionEventChangesQueryDto } from './dto/lpr-detection-event-changes-query.dto';
import { LprDetectionEventDto } from './dto/lpr-detection-event.dto';
import { LprDetectionEventImageSignedUrlDto } from './dto/lpr-detection-event-image-signed-url.dto';
import { ListLprDetectionEventsQueryDto } from './dto/list-lpr-detection-events-query.dto';
import { UpdateLprDetectionEventDto } from './dto/update-lpr-detection-event.dto';
import { UpsertLprDetectionEventDto } from './dto/upsert-lpr-detection-event.dto';

/** Validity window of an image signed URL, in seconds (5 minutes). */
const IMAGE_SIGNED_URL_TTL = 300;

type ChangesResponse = {
  items: LprDetectionEventDto[];
  maxSeq: number;
};

type TenantInjectedLprDetectionEventCreateInput = Omit<
  Prisma.LprDetectionEventUncheckedCreateInput,
  'tenantId'
>;

function jsonArray(value: Prisma.JsonValue): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function toLprDetectionEventDto(
  event: LprDetectionEvent,
): LprDetectionEventDto {
  return {
    id: event.id,
    tenantId: event.tenantId,
    cameraId: event.cameraId,
    location: event.location,
    firstSeenAt: event.firstSeenAt,
    lastSeenAt: event.lastSeenAt,
    rawText: event.rawText,
    normalizedText: event.normalizedText,
    displayPlate: event.displayPlate,
    confidence: event.confidence,
    formatValid: event.formatValid,
    formatType: event.formatType,
    qualityStatus: event.qualityStatus,
    status: event.status,
    entryId: event.entryId,
    reviewedAt: event.reviewedAt,
    reviewedByUserId: event.reviewedByUserId,
    imageStoragePath: event.imageStoragePath,
    imageUrl: event.imageUrl,
    bestCaptureId: event.bestCaptureId,
    candidates: jsonArray(event.candidates),
    version: event.version,
    syncSeq: event.syncSeq,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

function isResolved(status: LprDetectionStatus): boolean {
  return status !== LprDetectionStatus.pending;
}

function auditActionFor(status: LprDetectionStatus): string | null {
  if (status === LprDetectionStatus.registered) {
    return AuditActions.LPR_EVENT_REGISTERED;
  }
  if (status === LprDetectionStatus.dismissed) {
    return AuditActions.LPR_EVENT_DISMISSED;
  }
  if (status.startsWith('suppressed_')) {
    return AuditActions.LPR_EVENT_SUPPRESSED;
  }
  return null;
}

@Injectable()
export class LprEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  async upsert(
    dto: UpsertLprDetectionEventDto,
    actor: User,
  ): Promise<LprDetectionEventDto> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const tenantPrisma = this.prisma.getTenantClient();
    const incomingStatus = dto.status ?? LprDetectionStatus.pending;
    const existing = await tenantPrisma.lprDetectionEvent.findFirst({
      where: { id: dto.id },
    });

    if (existing) {
      const nextStatus =
        isResolved(existing.status) &&
        incomingStatus === LprDetectionStatus.pending
          ? existing.status
          : incomingStatus;
      const statusChanged = existing.status !== nextStatus;
      await tenantPrisma.lprDetectionEvent.updateMany({
        where: { tenantId, id: dto.id },
        data: this.toMutationData(dto, nextStatus, actor, existing),
      });
      const updated = await tenantPrisma.lprDetectionEvent.findFirstOrThrow({
        where: { id: dto.id },
      });
      if (statusChanged) {
        await this.recordStatusAudit(updated, actor);
      }
      return toLprDetectionEventDto(updated);
    }

    const created = await tenantPrisma.lprDetectionEvent.create({
      data: this.toCreateData(
        dto,
        incomingStatus,
        actor,
      ) as Prisma.LprDetectionEventUncheckedCreateInput,
    });
    if (isResolved(created.status)) {
      await this.recordStatusAudit(created, actor);
    }
    return toLprDetectionEventDto(created);
  }

  async updateStatus(
    eventId: string,
    dto: UpdateLprDetectionEventDto,
    actor: User,
  ): Promise<LprDetectionEventDto> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const tenantPrisma = this.prisma.getTenantClient();
    const existing = await tenantPrisma.lprDetectionEvent.findFirst({
      where: { id: eventId },
    });
    if (!existing) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        'LPR detection event not found.',
        `/tenants/${tenantId}/lpr-events/${eventId}`,
        ErrorCodes.NOT_FOUND,
      );
    }

    await tenantPrisma.lprDetectionEvent.updateMany({
      where: { tenantId, id: eventId },
      data: {
        status: dto.status,
        entryId: dto.entryId ?? existing.entryId,
        reviewedAt: dto.reviewedAt ? new Date(dto.reviewedAt) : new Date(),
        reviewedByUserId: actor.id,
      },
    });
    const updated = await tenantPrisma.lprDetectionEvent.findFirstOrThrow({
      where: { id: eventId },
    });
    if (existing.status !== updated.status) {
      await this.recordStatusAudit(updated, actor);
    }
    return toLprDetectionEventDto(updated);
  }

  /**
   * Uploads the event's photo to the private bucket (service-role, bypasses
   * storage RLS) and persists its path. Path is deterministic
   * (`<tenantId>/<eventId>.jpg`) so a retried upload after a dropped
   * connection just overwrites the same object instead of leaking orphans.
   */
  async uploadImage(
    eventId: string,
    body: Buffer,
    contentType: string,
  ): Promise<LprDetectionEventDto> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const tenantPrisma = this.prisma.getTenantClient();
    const existing = await tenantPrisma.lprDetectionEvent.findFirst({
      where: { id: eventId },
    });
    if (!existing) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        'LPR detection event not found.',
        `/tenants/${tenantId}/lpr-events/${eventId}/image`,
        ErrorCodes.NOT_FOUND,
      );
    }

    const path = `${tenantId}/${eventId}.jpg`;
    await this.storage.upload(
      LPR_DETECTION_IMAGES_BUCKET,
      path,
      body,
      contentType,
    );

    await tenantPrisma.lprDetectionEvent.updateMany({
      where: { tenantId, id: eventId },
      data: { imageStoragePath: path },
    });
    const updated = await tenantPrisma.lprDetectionEvent.findFirstOrThrow({
      where: { id: eventId },
    });
    return toLprDetectionEventDto(updated);
  }

  /**
   * Mints a short-lived signed URL so an owner/operator can preview an
   * event's photo. Never persisted: the photo is sensitive (plate + vehicle
   * appearance), so URLs are minted on demand instead of stored permanently.
   */
  async getImageSignedUrl(
    eventId: string,
  ): Promise<LprDetectionEventImageSignedUrlDto> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const tenantPrisma = this.prisma.getTenantClient();
    const existing = await tenantPrisma.lprDetectionEvent.findFirst({
      where: { id: eventId },
    });
    if (!existing?.imageStoragePath) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        'LPR detection event has no stored image.',
        `/tenants/${tenantId}/lpr-events/${eventId}/image-signed-url`,
        ErrorCodes.NOT_FOUND,
      );
    }

    const url = await this.storage.createSignedUrl(
      LPR_DETECTION_IMAGES_BUCKET,
      existing.imageStoragePath,
      IMAGE_SIGNED_URL_TTL,
    );
    return { url, expiresIn: IMAGE_SIGNED_URL_TTL };
  }

  async pullChanges(
    query: LprDetectionEventChangesQueryDto,
  ): Promise<ChangesResponse> {
    const tenantPrisma = this.prisma.getTenantClient();
    const items = await tenantPrisma.lprDetectionEvent.findMany({
      where: { syncSeq: { gt: query.afterSeq } },
      orderBy: [{ syncSeq: 'asc' }],
      take: query.limit,
    });
    const maxSeq =
      items.length > 0 ? items[items.length - 1].syncSeq : query.afterSeq;
    return { items: items.map(toLprDetectionEventDto), maxSeq };
  }

  async list(
    query: ListLprDetectionEventsQueryDto,
  ): Promise<LprDetectionEventDto[]> {
    const tenantPrisma = this.prisma.getTenantClient();
    const items = await tenantPrisma.lprDetectionEvent.findMany({
      where: query.status ? { status: query.status } : undefined,
      orderBy: [{ lastSeenAt: 'desc' }],
      take: query.limit,
    });
    return items.map(toLprDetectionEventDto);
  }

  private toCreateData(
    dto: UpsertLprDetectionEventDto,
    status: LprDetectionStatus,
    actor: User,
  ): TenantInjectedLprDetectionEventCreateInput {
    return {
      id: dto.id,
      cameraId: dto.cameraId,
      location: dto.location,
      firstSeenAt: new Date(dto.firstSeenAt),
      lastSeenAt: new Date(dto.lastSeenAt),
      rawText: dto.rawText,
      normalizedText: dto.normalizedText,
      displayPlate: dto.displayPlate,
      confidence: dto.confidence,
      formatValid: dto.formatValid,
      formatType: dto.formatType,
      qualityStatus: dto.qualityStatus,
      status,
      entryId: dto.entryId,
      reviewedAt: isResolved(status)
        ? dto.reviewedAt
          ? new Date(dto.reviewedAt)
          : new Date()
        : undefined,
      reviewedByUserId: isResolved(status) ? actor.id : undefined,
      imageStoragePath: dto.imageStoragePath,
      imageUrl: dto.imageUrl,
      bestCaptureId: dto.bestCaptureId,
      candidates: (dto.candidates ?? []) as Prisma.InputJsonValue,
    };
  }

  private toMutationData(
    dto: UpsertLprDetectionEventDto,
    status: LprDetectionStatus,
    actor: User,
    existing: LprDetectionEvent,
  ): Prisma.LprDetectionEventUncheckedUpdateManyInput {
    const resolved = isResolved(status);
    return {
      cameraId: dto.cameraId,
      location: dto.location,
      firstSeenAt: new Date(dto.firstSeenAt),
      lastSeenAt: new Date(dto.lastSeenAt),
      rawText: dto.rawText,
      normalizedText: dto.normalizedText,
      displayPlate: dto.displayPlate,
      confidence: dto.confidence,
      formatValid: dto.formatValid,
      formatType: dto.formatType,
      qualityStatus: dto.qualityStatus,
      status,
      entryId: dto.entryId ?? existing.entryId,
      reviewedAt: resolved
        ? dto.reviewedAt
          ? new Date(dto.reviewedAt)
          : (existing.reviewedAt ?? new Date())
        : existing.reviewedAt,
      reviewedByUserId: resolved
        ? (existing.reviewedByUserId ?? actor.id)
        : existing.reviewedByUserId,
      imageStoragePath: dto.imageStoragePath ?? existing.imageStoragePath,
      imageUrl: dto.imageUrl ?? existing.imageUrl,
      bestCaptureId: dto.bestCaptureId ?? existing.bestCaptureId,
      candidates: (dto.candidates ??
        jsonArray(existing.candidates)) as Prisma.InputJsonValue,
    };
  }

  private async recordStatusAudit(
    event: LprDetectionEvent,
    actor: User,
  ): Promise<void> {
    const action = auditActionFor(event.status);
    if (!action) return;
    await this.audit.record({
      action,
      entityType: 'lpr_detection_event',
      entityId: event.id,
      actorUserId: actor.id,
      tenantId: event.tenantId,
      severity: event.status === LprDetectionStatus.dismissed ? 'warn' : 'info',
      metadata: {
        status: event.status,
        normalizedText: event.normalizedText,
        confidence: event.confidence,
        qualityStatus: event.qualityStatus,
        entryId: event.entryId,
      },
    });
  }
}
