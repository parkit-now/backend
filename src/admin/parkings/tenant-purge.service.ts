import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Prisma, Tenant } from '@prisma/client';
import { AuditActions, AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../database/prisma.service';
import {
  APPLICATION_DOCUMENTS_BUCKET,
  LPR_DETECTION_IMAGES_BUCKET,
  StorageService,
} from '../../storage/storage.service';

/** Cuántos estacionamientos purga una corrida, como tope de seguridad. */
const MAX_PER_RUN = 10;

interface PurgeCounts {
  lprImages: number;
  applicationDocuments: number;
  auditRows: number;
  applications: number;
  vehicles: number;
  vehicleTypes: number;
}

/**
 * Borra definitivamente los estacionamientos dados de baja cuya ventana de
 * gracia ya venció. Es el único lugar del backend que borra de verdad.
 *
 * CORRE A LAS 4:30, DESPUÉS DE `LprImageRetentionService` (4:00)
 *
 * No se pisan por diseño: la retención saltea los tenants dados de baja
 * (`deletedAt: null` en sus tres tiers), así que durante la ventana de gracia
 * nadie les toca las fotos y restaurar devuelve la evidencia entera. Recién
 * acá, cuando el borrado ya es irreversible, se borran todas juntas.
 *
 * EL ORDEN DE ABAJO ES LA PARTE QUE IMPORTA
 *
 *   1. Storage SIEMPRE primero. Las rutas de los archivos viven en la base: si
 *      se borra la base y después falla Storage, quedan archivos sin ninguna
 *      fila que diga a quién pertenecían, y ya no hay forma de encontrarlos.
 *   2. `audit_log` y `onboarding_applications` a mano. Sus FK son
 *      `ON DELETE SET NULL`, o sea que el cascade no las borra: las ANONIMIZA.
 *      Quedan con `tenant_id = NULL`, invisibles desde el panel y sin nada que
 *      diga de qué estacionamiento eran. Peor que borrarlas.
 *   3. `vehicles` ANTES que `vehicle_types`. `vehicles_tenant_type_fkey` es
 *      `ON DELETE RESTRICT`: que el borrado funcione hoy depende de que los
 *      triggers RI de Postgres disparen `vehicles` primero, y eso pasa sólo
 *      porque los ejecuta en orden alfabético y el OID quedó más bajo. Si
 *      alguna vez se recrea ese FK, el orden se invierte y todo borrado con
 *      vehículos empieza a fallar. Hacerlo explícito desactiva esa bomba.
 *   4. `tenant.delete()` al final, que cascadea las veintidós tablas restantes.
 *
 * DRY-RUN POR DEFECTO. `TENANT_PURGE_DRY_RUN` tiene que valer exactamente
 * `'false'` para que borre. Es el mismo patrón que la retención de imágenes —
 * cuya variable nunca se definió en producción, y por eso ese job no corrió
 * nunca de verdad. Las dos están ahora en `.env.production`.
 */
@Injectable()
export class TenantPurgeService {
  private readonly logger = new Logger(TenantPurgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private get dryRun(): boolean {
    return this.config.get('TENANT_PURGE_DRY_RUN') !== 'false';
  }

  @Cron('30 4 * * *', { name: 'tenant-purge' })
  async run(now = new Date()): Promise<void> {
    const dryRun = this.dryRun;

    const due = await this.prisma.tenant.findMany({
      where: { deletedAt: { not: null }, purgeAfter: { lte: now } },
      take: MAX_PER_RUN,
      orderBy: { purgeAfter: 'asc' },
    });

    this.logger.log(
      `Tenant purge run (dryRun=${dryRun}): ${due.length} tenant(s) due.`,
    );

    for (const tenant of due) {
      // Cada uno por separado: que uno falle no puede costarle la corrida a
      // los demás. El que falla queda dado de baja y lo reintenta mañana.
      try {
        await this.purgeOne(tenant, dryRun);
      } catch (error) {
        this.logger.error(
          `Failed to purge tenant ${tenant.id} (${tenant.name})`,
          error instanceof Error ? error.stack : error,
        );
      }
    }
  }

  private async purgeOne(tenant: Tenant, dryRun: boolean): Promise<void> {
    const id = tenant.id;

    // Plata de terceros sin resolver: no se purga. Es la única guarda dura del
    // sistema, y está acá y no en la baja porque acá es donde se pierde la
    // posibilidad de devolver el dinero. Queda pendiente y vuelve a intentarse.
    const pendingRefunds = await this.prisma.reservation.count({
      where: { tenantId: id, refundStatus: 'pending' },
    });
    if (pendingRefunds > 0) {
      this.logger.warn(
        `Skipping purge of tenant ${id} (${tenant.name}): ${pendingRefunds} pending refund(s). ` +
          'Resolve them and the next run will pick it up.',
      );
      return;
    }

    const [lprPaths, documents] = await Promise.all([
      this.prisma.lprDetectionEvent.findMany({
        where: { tenantId: id, imageStoragePath: { not: null } },
        select: { imageStoragePath: true },
      }),
      this.prisma.applicationDocument.findMany({
        where: { application: { tenantId: id } },
        select: { storagePath: true },
      }),
    ]);

    const counts: PurgeCounts = {
      lprImages: lprPaths.length,
      applicationDocuments: documents.length,
      auditRows: await this.prisma.auditLog.count({ where: { tenantId: id } }),
      applications: await this.prisma.onboardingApplication.count({
        where: { tenantId: id },
      }),
      vehicles: await this.prisma.vehicle.count({ where: { tenantId: id } }),
      vehicleTypes: await this.prisma.vehicleType.count({
        where: { tenantId: id },
      }),
    };

    if (dryRun) {
      this.logger.log(
        `[dry-run] Would purge tenant ${id} (${tenant.name}): ${JSON.stringify(counts)}`,
      );
      return;
    }

    // 1. Storage primero.
    await this.storage.removeMany(
      LPR_DETECTION_IMAGES_BUCKET,
      lprPaths.map((row) => row.imageStoragePath!),
    );
    await this.storage.removeMany(
      APPLICATION_DOCUMENTS_BUCKET,
      documents.map((row) => row.storagePath),
    );

    // 2-4. La base, en una transacción: o se va entero o no se va nada.
    await this.prisma.$transaction(async (tx) => {
      await this.purgeRows(tx, id);
      await tx.tenant.delete({ where: { id } });
    });

    // La auditoría va DESPUÉS y fuera de la transacción: adentro se borraría
    // junto con el resto de las filas del tenant.
    await this.audit.record({
      action: AuditActions.PARKING_PURGED,
      entityType: 'tenant',
      entityId: id,
      // `tenantId` queda en NULL a propósito: el tenant ya no existe y la FK
      // lo rechazaría. El nombre va en `metadata` o se pierde para siempre.
      actorUserId: tenant.deletedById,
      severity: 'warn',
      metadata: {
        name: tenant.name,
        deletedAt: tenant.deletedAt?.toISOString() ?? null,
        purgedCounts: { ...counts },
      },
    });

    this.logger.log(
      `Purged tenant ${id} (${tenant.name}): ${JSON.stringify(counts)}`,
    );
  }

  /**
   * Las filas que el cascade NO se lleva bien, en orden.
   *
   * Es una lista explícita y no un `delete` a secas porque los dos problemas
   * que resuelve son invisibles: las FK `SET NULL` que anonimizan en vez de
   * borrar, y el `RESTRICT` de `vehicles_tenant_type_fkey`, que hoy no explota
   * de casualidad. Ver el docstring de la clase.
   */
  private async purgeRows(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<void> {
    // `SET NULL`: el cascade las dejaría anonimizadas.
    await tx.auditLog.deleteMany({ where: { tenantId } });
    await tx.onboardingApplication.deleteMany({ where: { tenantId } });

    // `RESTRICT`: el orden acá es obligatorio, no una preferencia.
    await tx.vehicle.deleteMany({ where: { tenantId } });
    await tx.vehicleType.deleteMany({ where: { tenantId } });
  }
}
