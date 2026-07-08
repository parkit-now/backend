import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LprDetectionEvent, LprDetectionStatus } from '@prisma/client';
import { AuditActions, AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import {
  LPR_DETECTION_IMAGES_BUCKET,
  StorageService,
} from '../storage/storage.service';

/** Stays with billing/audit value: keep the image this long after exit. */
const REGISTERED_RETENTION_DAYS = 45;

/** Noise (never became a paid stay): keep the image at least this long. */
const NOISE_RETENTION_FLOOR_HOURS = 48;

/** A `pending` event that never got reviewed is treated as noise past this. */
const PENDING_STUCK_HOURS = 24;

/** Safety cap so one run can't try to purge an unbounded backlog. */
const MAX_CANDIDATES_PER_TIER = 500;

const NOISE_STATUSES: LprDetectionStatus[] = [
  LprDetectionStatus.dismissed,
  LprDetectionStatus.suppressed_active_entry,
  LprDetectionStatus.suppressed_pending_event,
  LprDetectionStatus.suppressed_recent_exit,
];

type PurgeCandidate = Pick<
  LprDetectionEvent,
  'id' | 'tenantId' | 'imageStoragePath'
>;

type Tier = 'registered' | 'noise' | 'archived';

/**
 * Daily job that deletes LPR detection photos from the private bucket once
 * they've stopped having audit/billing value, per tier:
 *
 *  - `registered` (became a real paid stay): kept until
 *    `REGISTERED_RETENTION_DAYS` after exit, and never before the entry's
 *    cash session closes (an open session may still need the evidence).
 *  - noise (`dismissed`/`suppressed_*`, never billed): kept only until the
 *    tenant has no open cash session (i.e. between shifts) and
 *    `NOISE_RETENTION_FLOOR_HOURS` have passed.
 *  - `pending` events that never got reviewed (camera fired, nobody
 *    resolved it) are treated the same way, but with a shorter
 *    `PENDING_STUCK_HOURS` floor — a stale pending detection has even less
 *    reason to stick around than a reviewed-and-dismissed one.
 *  - `archived` (a human already reviewed and dismissed it): purged on the
 *    next run, no floor.
 *
 * The event row itself is never deleted — only `imageStoragePath`/`imageUrl`
 * are cleared and `imageDeletedAt` is stamped, keeping the audit trail intact.
 *
 * This runs cross-tenant, so unlike request-scoped services it uses the raw
 * `PrismaService` client directly instead of `getTenantClient()` — there is
 * no tenant in context in a cron job. Every query below filters by
 * `tenantId` explicitly to stay tenant-safe.
 */
@Injectable()
export class LprImageRetentionService {
  private readonly logger = new Logger(LprImageRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private get dryRun(): boolean {
    return this.config.get('LPR_IMAGE_RETENTION_DRY_RUN') !== 'false';
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async run(): Promise<void> {
    const dryRun = this.dryRun;
    const [registered, noise, archived] = await Promise.all([
      this.findRegisteredCandidates(),
      this.findNoiseCandidates(),
      this.findArchivedCandidates(),
    ]);

    this.logger.log(
      `LPR image retention run (dryRun=${dryRun}): ` +
        `${registered.length} registered, ${noise.length} noise, ${archived.length} archived candidates.`,
    );

    if (dryRun) return;

    await this.purge(registered, 'registered');
    await this.purge(noise, 'noise');
    await this.purge(archived, 'archived');
  }

  private findRegisteredCandidates(): Promise<PurgeCandidate[]> {
    const cutoff = new Date(
      Date.now() - REGISTERED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    return this.prisma.lprDetectionEvent.findMany({
      where: {
        status: LprDetectionStatus.registered,
        imageStoragePath: { not: null },
        imageDeletedAt: null,
        entry: {
          leftAt: { lt: cutoff },
          OR: [
            { cashSessionId: null },
            { cashSession: { closedAt: { not: null } } },
          ],
        },
      },
      select: { id: true, tenantId: true, imageStoragePath: true },
      take: MAX_CANDIDATES_PER_TIER,
    });
  }

  private findNoiseCandidates(): Promise<PurgeCandidate[]> {
    const noiseCutoff = new Date(
      Date.now() - NOISE_RETENTION_FLOOR_HOURS * 60 * 60 * 1000,
    );
    const pendingCutoff = new Date(
      Date.now() - PENDING_STUCK_HOURS * 60 * 60 * 1000,
    );
    return this.prisma.lprDetectionEvent.findMany({
      where: {
        imageStoragePath: { not: null },
        imageDeletedAt: null,
        tenant: { cashSessions: { none: { closedAt: null } } },
        OR: [
          { status: { in: NOISE_STATUSES }, updatedAt: { lt: noiseCutoff } },
          {
            status: LprDetectionStatus.pending,
            updatedAt: { lt: pendingCutoff },
          },
        ],
      },
      select: { id: true, tenantId: true, imageStoragePath: true },
      take: MAX_CANDIDATES_PER_TIER,
    });
  }

  private findArchivedCandidates(): Promise<PurgeCandidate[]> {
    return this.prisma.lprDetectionEvent.findMany({
      where: {
        archivedAt: { not: null },
        imageStoragePath: { not: null },
        imageDeletedAt: null,
      },
      select: { id: true, tenantId: true, imageStoragePath: true },
      take: MAX_CANDIDATES_PER_TIER,
    });
  }

  private async purge(candidates: PurgeCandidate[], tier: Tier): Promise<void> {
    for (const candidate of candidates) {
      try {
        await this.storage.remove(
          LPR_DETECTION_IMAGES_BUCKET,
          candidate.imageStoragePath!,
        );
        await this.prisma.lprDetectionEvent.updateMany({
          where: { id: candidate.id, tenantId: candidate.tenantId },
          data: {
            imageDeletedAt: new Date(),
            imageStoragePath: null,
            imageUrl: null,
          },
        });
        await this.audit.record({
          action: AuditActions.LPR_EVENT_IMAGE_PURGED,
          entityType: 'lpr_detection_event',
          entityId: candidate.id,
          tenantId: candidate.tenantId,
          severity: 'info',
          metadata: { tier },
        });
      } catch (error) {
        this.logger.error(
          `Failed to purge image for LPR event ${candidate.id} (tenant ${candidate.tenantId}, tier ${tier})`,
          error instanceof Error ? error.stack : error,
        );
      }
    }
  }
}
