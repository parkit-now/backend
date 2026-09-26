import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { AuditActions, AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ArcaAccountsService, isCertified } from './arca-accounts.service';
import { ArcaConfigService } from './arca-config.service';
import { InvoicesService } from './invoices.service';

/** Con cuánta anticipación se prepara la renovación del certificado. */
export const RENEWAL_WINDOW_DAYS = 30;

/**
 * Un `issuing` más viejo que esto lo resuelve el job. Bastante más que los
 * 2 minutos de la reconciliación perezosa: acá no hay nadie esperando, y así
 * nunca se pisa con una emisión en curso.
 */
export const JOB_STALE_ISSUING_MS = 10 * 60_000;

/** Tope por tarea y por corrida: una corrida no se come un backlog infinito. */
const MAX_CANDIDATES = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ArcaMaintenanceResult {
  readonly dryRun: boolean;
  /** Certificados (no sedes) a los que se les preparó la renovación. */
  readonly renewalsPrepared: number;
  /** Sedes que pasaron a `cert_expired`. */
  readonly expiredMarked: number;
  /** Facturas `issuing` resueltas (a `issued` o a `error`). */
  readonly invoicesReconciled: number;
}

/**
 * Job diario de mantenimiento de ARCA. Tres tareas:
 *
 * 1. **Preparar la renovación** de los certificados que vencen en
 *    `RENEWAL_WINDOW_DAYS` o menos: clave y CSR nuevos, sin tocar el vigente.
 *    Una sola por certificado, aunque lo compartan varias sedes. El dueño
 *    después la sube a ARCA desde el panel.
 * 2. **Marcar vencidos**: `linked` con el certificado vencido → `cert_expired`.
 *    La emisión ya chequea el vencimiento en el punto de uso; esto es para que
 *    el panel y el desktop lo muestren.
 * 3. **Reconciliar** las facturas trabadas en `issuing`.
 *
 * Corre cross-tenant, así que usa el `PrismaService` crudo con filtro
 * explícito, igual que `LprImageRetentionService`.
 *
 * ## Sólo `@Cron`, a las 12:00 de Argentina, sin Cloud Scheduler
 *
 * Decisión del proyecto: nada que pueda generar un cobro de GCP. El precio es
 * que en Cloud Run el cron es de mejor esfuerzo: si a esa hora no hay ninguna
 * instancia viva (scale-to-zero), ese día no corre. Por eso va al mediodía,
 * cuando las playas están cobrando y es casi seguro que hay una instancia, y
 * con la zona horaria explícita (Cloud Run está en UTC). Si varias instancias
 * lo disparan a la vez no pasa nada: cada escritura es condicional.
 *
 * Que un día no corra no rompe nada: la emisión chequea el vencimiento en el
 * punto de uso y las `issuing` se reconcilian en la próxima emisión con esa
 * numeración. Lo que se atrasa es el aviso (la card y el CSR preparado).
 *
 * `ARCA_MAINTENANCE_DRY_RUN` (en `true` salvo que diga `false`) sólo cuenta
 * candidatos y no toca nada.
 */
@Injectable()
export class ArcaMaintenanceService {
  private readonly logger = new Logger(ArcaMaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly arcaConfig: ArcaConfigService,
    private readonly accounts: ArcaAccountsService,
    private readonly invoices: InvoicesService,
    private readonly audit: AuditService,
  ) {}

  private get dryRun(): boolean {
    return this.config.get('ARCA_MAINTENANCE_DRY_RUN') !== 'false';
  }

  @Cron('0 12 * * *', {
    name: 'arca-maintenance',
    timeZone: 'America/Argentina/Buenos_Aires',
  })
  async run(): Promise<ArcaMaintenanceResult> {
    const dryRun = this.dryRun;
    if (!this.arcaConfig.enabled) {
      return {
        dryRun,
        renewalsPrepared: 0,
        expiredMarked: 0,
        invoicesReconciled: 0,
      };
    }

    const [toRenew, expired, staleCount] = await Promise.all([
      this.findRenewalCandidates(),
      this.findExpired(),
      this.prisma.invoice.count({
        where: {
          status: 'issuing',
          issuingStartedAt: { lt: new Date(Date.now() - JOB_STALE_ISSUING_MS) },
        },
      }),
    ]);
    this.logger.log(
      `Mantenimiento ARCA (dryRun=${dryRun}): ${toRenew.length} certificados ` +
        `a renovar, ${expired.length} sedes vencidas, ${staleCount} facturas trabadas.`,
    );

    if (dryRun) {
      return {
        dryRun,
        renewalsPrepared: toRenew.length,
        expiredMarked: expired.length,
        invoicesReconciled: Math.min(staleCount, MAX_CANDIDATES),
      };
    }

    const renewalsPrepared = await this.prepareRenewals(toRenew);
    const expiredMarked = await this.markExpired(expired);
    const { reconciled } = await this.invoices.reconcileStaleIssuing({
      olderThanMs: JOB_STALE_ISSUING_MS,
      limit: MAX_CANDIDATES,
    });
    return {
      dryRun,
      renewalsPrepared,
      expiredMarked,
      invoicesReconciled: reconciled,
    };
  }

  /** Una cuenta por certificado: la renovación después se copia a las demás. */
  private async findRenewalCandidates() {
    const now = Date.now();
    const accounts = await this.prisma.arcaAccount.findMany({
      where: {
        environment: this.arcaConfig.environment,
        status: 'linked',
        renewalCsrPem: null,
        certExpiresAt: {
          gt: new Date(now),
          lte: new Date(now + RENEWAL_WINDOW_DAYS * DAY_MS),
        },
      },
      orderBy: { certExpiresAt: 'asc' },
      take: MAX_CANDIDATES,
    });
    const byCertificate = new Map<string, (typeof accounts)[number]>();
    for (const account of accounts) {
      if (!isCertified(account)) continue;
      if (!byCertificate.has(account.certFingerprint)) {
        byCertificate.set(account.certFingerprint, account);
      }
    }
    return [...byCertificate.values()].filter(isCertified);
  }

  private findExpired() {
    return this.prisma.arcaAccount.findMany({
      where: {
        environment: this.arcaConfig.environment,
        status: 'linked',
        certExpiresAt: { lte: new Date() },
      },
      select: { id: true, tenantId: true, cuit: true, certExpiresAt: true },
      take: MAX_CANDIDATES,
    });
  }

  private async prepareRenewals(
    accounts: Awaited<ReturnType<typeof this.findRenewalCandidates>>,
  ): Promise<number> {
    let prepared = 0;
    for (const account of accounts) {
      try {
        await this.accounts.prepareRenewal(account);
        prepared++;
        await this.audit.record({
          action: AuditActions.ARCA_RENEWAL_PREPARED,
          entityType: 'arca_account',
          entityId: account.id,
          tenantId: account.tenantId,
          severity: 'info',
          metadata: {
            cuit: account.cuit,
            certExpiresAt: account.certExpiresAt?.toISOString() ?? null,
          },
        });
      } catch (error) {
        this.logger.error(
          `No se pudo preparar la renovación del certificado de la cuenta ${account.id} (tenant ${account.tenantId})`,
          error instanceof Error ? error.stack : error,
        );
      }
    }
    return prepared;
  }

  private async markExpired(
    accounts: Awaited<ReturnType<typeof this.findExpired>>,
  ): Promise<number> {
    let marked = 0;
    for (const account of accounts) {
      try {
        // Condicional: si el dueño renovó entre la búsqueda y acá, no se toca.
        const { count } = await this.prisma.arcaAccount.updateMany({
          where: {
            id: account.id,
            tenantId: account.tenantId,
            status: 'linked',
            certExpiresAt: { lte: new Date() },
          },
          data: { status: 'cert_expired' },
        });
        if (count === 0) continue;
        marked++;
        await this.audit.record({
          action: AuditActions.ARCA_CERTIFICATE_EXPIRED,
          entityType: 'arca_account',
          entityId: account.id,
          tenantId: account.tenantId,
          severity: 'warn',
          metadata: {
            cuit: account.cuit,
            certExpiresAt: account.certExpiresAt?.toISOString() ?? null,
          },
        });
      } catch (error) {
        this.logger.error(
          `No se pudo marcar vencida la cuenta ${account.id} (tenant ${account.tenantId})`,
          error instanceof Error ? error.stack : error,
        );
      }
    }
    return marked;
  }
}
