import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiExcludeController,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import {
  type ArcaMaintenanceResult,
  ArcaMaintenanceService,
} from './arca-maintenance.service';

const SECRET_HEADER = 'x-internal-job-secret';

/**
 * ¿El header trae el secreto del job? Sin secreto configurado, NUNCA: un
 * endpoint interno abierto por olvido es peor que uno que no anda.
 *
 * Se comparan los SHA-256 con `timingSafeEqual`: comparar strings con `===`
 * corta en el primer carácter distinto y el tiempo de respuesta filtra cuánto
 * se acertó; hashear antes iguala los largos, que `timingSafeEqual` exige.
 */
export function isValidJobSecret(
  configured: string | undefined,
  received: string | undefined,
): boolean {
  if (!configured || !received) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(configured), digest(received));
}

/**
 * Disparo externo del job de mantenimiento de ARCA. En Cloud Run, con
 * scale-to-zero, el `@Cron` puede no correr nunca: Cloud Scheduler pega acá
 * todos los días. No lleva JWT (no hay usuario): lo protege
 * `ARCA_INTERNAL_JOB_SECRET` en el header `X-Internal-Job-Secret`.
 */
@ApiExcludeController()
@Controller('internal/jobs')
export class ArcaMaintenanceController {
  constructor(
    private readonly maintenance: ArcaMaintenanceService,
    private readonly config: ConfigService,
  ) {}

  @Post('arca-maintenance')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run the daily ARCA maintenance job' })
  @ApiHeader({ name: 'X-Internal-Job-Secret', required: true })
  @ApiOkResponse()
  @ApiUnauthorizedResponse()
  run(
    @Headers(SECRET_HEADER) secret: string | undefined,
  ): Promise<ArcaMaintenanceResult> {
    const configured = this.config.get<string>('ARCA_INTERNAL_JOB_SECRET');
    if (!isValidJobSecret(configured?.trim(), secret?.trim())) {
      throw new FormattedException(
        'Unauthorized',
        HttpStatus.UNAUTHORIZED,
        'Missing or invalid internal job secret.',
        '/internal/jobs/arca-maintenance',
        ErrorCodes.UNAUTHORIZED,
      );
    }
    return this.maintenance.run();
  }
}
