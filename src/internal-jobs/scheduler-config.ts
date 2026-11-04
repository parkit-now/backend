import type { ConfigService } from '@nestjs/config';

export interface SchedulerConfig {
  /** Audiencia del token OIDC: la URL del servicio de Cloud Run. */
  audience: string;
  /** Service account con la que Cloud Scheduler firma la llamada. */
  invoker: string;
}

/**
 * La configuración de Cloud Scheduler, o `null` si este entorno no lo usa.
 *
 * Es la llave de quién dispara los jobs: con las dos variables cargadas los
 * dispara Scheduler por `/internal/jobs/*` y los `@Cron` locales no hacen
 * nada; sin ellas (local) es al revés y los endpoints responden 404.
 */
export function schedulerConfig(config: ConfigService): SchedulerConfig | null {
  const audience = config.get<string>('INTERNAL_JOBS_AUDIENCE');
  const invoker = config.get<string>('INTERNAL_JOBS_INVOKER_EMAIL');
  return audience && invoker ? { audience, invoker } : null;
}
