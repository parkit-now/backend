import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LprImageRetentionService } from '../lpr-events/lpr-image-retention.service';
import { schedulerConfig } from './scheduler-config';

/**
 * Los mismos jobs que dispara Cloud Scheduler, pero con `@Cron` dentro del
 * proceso, para los entornos que no tienen Scheduler (local).
 *
 * Donde Scheduler está configurado este cron no hace nada: tener los dos
 * disparadores a la vez duplicaba corridas y obligaba a pensar en dos
 * horarios de borrado, y el `@Cron` en Cloud Run sólo corre si justo hay una
 * instancia viva, así que tampoco servía de respaldo. Para eso están los
 * reintentos del propio Scheduler.
 */
@Injectable()
export class LocalJobsCron {
  constructor(
    private readonly config: ConfigService,
    private readonly lprImageRetention: LprImageRetentionService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'lpr-image-retention' })
  async lprImageRetentionRun(): Promise<void> {
    if (schedulerConfig(this.config) !== null) return;
    await this.lprImageRetention.run();
  }
}
