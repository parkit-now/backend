import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  LprImageRetentionService,
  type LprImageRetentionSummary,
} from '../lpr-events/lpr-image-retention.service';
import { SchedulerOidcGuard } from './scheduler-oidc.guard';

/**
 * Jobs de mantenimiento disparados desde afuera por Cloud Scheduler.
 *
 * Existe porque en Cloud Run (scale-to-zero, CPU sólo durante un request) un
 * `@Cron` corre únicamente si justo hay una instancia viva: la retención de
 * imágenes LPR, a las 4:00, corría unas pocas noches por quincena. Un request
 * de Scheduler levanta la instancia y le da CPU mientras dura el job.
 *
 * No es parte del contrato de los frontends: queda fuera de OpenAPI.
 */
@ApiExcludeController()
@Controller('internal/jobs')
@UseGuards(SchedulerOidcGuard)
export class InternalJobsController {
  constructor(private readonly lprImageRetention: LprImageRetentionService) {}

  @Post('lpr-image-retention')
  @HttpCode(200)
  runLprImageRetention(): Promise<LprImageRetentionSummary> {
    return this.lprImageRetention.run();
  }
}
