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
 *  - `registered` (became a real paid stay): kept until the owner-configured
 *    `Tenant.lprImageRetentionDays` (30/60/90, default 30) have passed since
 *    exit, and never before the entry's cash session closes (an open session
 *    may still need the evidence).
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
 *
 * LOS TRES TIERS SALTEAN LOS TENANTS DADOS DE BAJA (`deletedAt: null`), y eso
 * NO es cosmético: durante la ventana de gracia un estacionamiento dado de baja
 * todavía se puede restaurar. Si este job le fuera borrando las fotos mientras
 * tanto, restaurarlo devolvería las filas pero no la evidencia, en silencio.
 * Las imágenes de un tenant dado de baja las borra `TenantPurgeService`, todas
 * juntas y recién cuando el borrado ya es irreversible.
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

  private async findRegisteredCandidates(): Promise<PurgeCandidate[]> {
    // Retention for this tier is per-tenant (owner-configurable). Group the
    // tenants by their configured value so we run one query per distinct
    // cutoff instead of one per tenant.
    const tenants = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true, lprImageRetentionDays: true },
    });

    const tenantIdsByDays = new Map<number, string[]>();
    for (const { id, lprImageRetentionDays } of tenants) {
      const ids = tenantIdsByDays.get(lprImageRetentionDays) ?? [];
      ids.push(id);
      tenantIdsByDays.set(lprImageRetentionDays, ids);
    }

    const perGroup = await Promise.all(
      [...tenantIdsByDays].map(([days, tenantIds]) => {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        return this.prisma.lprDetectionEvent.findMany({
          where: {
            tenantId: { in: tenantIds },
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
      }),
    );

    return perGroup.flat().slice(0, MAX_CANDIDATES_PER_TIER);
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
        tenant: { deletedAt: null, cashSessions: { none: { closedAt: null } } },
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
        tenant: { deletedAt: null },
        archivedAt: { not: null },
        imageStoragePath: { not: null },
        imageDeletedAt: null,
      },
      select: { id: true, tenantId: true, imageStoragePath: true },
      take: MAX_CANDIDATES_PER_TIER,
    });
  }

  /**
   * Borra las fotos de un tier y marca sus filas.
   *
   * Va por lote (`removeMany`) y no de a una: con el tope de 500 por tier, de
   * a una eran hasta 1500 round-trips HTTP secuenciales por corrida. Si el
   * lote falla cae al camino de a uno, que es el que aguanta que UN objeto
   * raro no se pueda borrar sin costarle el tier entero a los demás.
   */
  private async purge(candidates: PurgeCandidate[], tier: Tier): Promise<void> {
    if (candidates.length === 0) return;

    try {
      await this.storage.removeMany(
        LPR_DETECTION_IMAGES_BUCKET,
        candidates.map((candidate) => candidate.imageStoragePath!),
      );
    } catch (error) {
      this.logger.error(
        `Batch removal failed for tier ${tier} (${candidates.length} objects); falling back to one by one`,
        error instanceof Error ? error.stack : error,
      );
      await this.purgeOneByOne(candidates, tier);
      return;
    }

    for (const candidate of candidates) {
      await this.markPurged(candidate, tier);
    }
  }

  /** El camino de respaldo: aísla el objeto que no se pudo borrar. */
  private async purgeOneByOne(
    candidates: PurgeCandidate[],
    tier: Tier,
  ): Promise<void> {
    for (const candidate of candidates) {
      try {
        await this.storage.remove(
          LPR_DETECTION_IMAGES_BUCKET,
          candidate.imageStoragePath!,
        );
      } catch (error) {
        this.logger.error(
          `Failed to purge image for LPR event ${candidate.id} (tenant ${candidate.tenantId}, tier ${tier})`,
          error instanceof Error ? error.stack : error,
        );
        continue;
      }
      await this.markPurged(candidate, tier);
    }
  }

  /**
   * La fila del evento NO se borra: sólo se limpian los campos de la imagen y
   * se sella `imageDeletedAt`, para que el rastro de auditoría quede entero.
   */
  private async markPurged(
    candidate: PurgeCandidate,
    tier: Tier,
  ): Promise<void> {
    try {
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
        `Failed to mark LPR event ${candidate.id} as purged (tenant ${candidate.tenantId}, tier ${tier})`,
        error instanceof Error ? error.stack : error,
      );
    }
  }
}
