import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../database/prisma.module';
import { MpAccountsController } from './mp-accounts.controller';
import { MpAccountsService } from './mp-accounts.service';
import { MpApiClient } from './mp-api.client';
import { MpConfigService } from './mp-config.service';
import { MpCryptoService } from './mp-crypto.service';
import { MpOauthController } from './mp-oauth.controller';
import { MpSignatureService } from './mp-signature.service';
import { MpTokenService } from './mp-token.service';
import { PaymentIntentsController } from './payment-intents.controller';
import { PaymentIntentsService } from './payment-intents.service';

/**
 * Integración con Mercado Pago: configuración validada al boot, cifrado de
 * tokens, verificación de firma de webhooks, cliente HTTP y la vinculación
 * OAuth de la cuenta de cobro de cada playa.
 *
 * `ConfigService` llega por el `ConfigModule.forRoot({ isGlobal: true })` de
 * `AppModule`, igual que en `StorageModule`.
 *
 * ## Ahora SÍ está registrado en `app.module.ts`
 *
 * En B1 no lo estaba, y el motivo estaba escrito acá: `MpConfigService` valida
 * el entorno con `getOrThrow` en `onModuleInit`, así que sin las `MP_*` el
 * proceso entero no levanta — y en B1 no había un solo endpoint que las usara,
 * con lo cual era todo costo y cero beneficio.
 *
 * Eso cambió en esta etapa: ya hay endpoints de vinculación que sin esas
 * variables no pueden hacer nada, así que el fail-fast ahora protege algo real.
 * Y se registra en el MISMO commit que suma las `MP_*` obligatorias a
 * `make env-check`, que es lo que hace que la falta de configuración se detecte
 * antes de desplegar y no cuando el proceso no arranca en Cloud Run.
 *
 * ## De dónde sale `PermissionsService`
 *
 * De `AuthModule`, que es `@Global()`: no se importa acá, igual que no lo
 * importa `EntitiesModule` pese a usar sus guards. Lo necesita
 * `MpAccountsService` porque el callback del OAuth no puede apoyarse en
 * `TenantMembershipGuard` (ver el docblock de `MpOauthController`), así que el
 * chequeo de `owner` lo hace el service a mano — con la MISMA fuente de verdad
 * que usaría el guard, no con una regla paralela.
 *
 * ## Por qué `MpTokenService` se EXPORTA
 *
 * Porque es el único camino para conseguir un access token vivo, y los payment
 * intents y el webhook lo van a inyectar desde afuera de este módulo. Si no se
 * exporta, el primero que lo necesite va a terminar descifrando el token por su
 * cuenta y salteándose el refresh perezoso y la degradación.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [
    MpAccountsController,
    MpOauthController,
    PaymentIntentsController,
  ],
  providers: [
    MpConfigService,
    MpCryptoService,
    MpSignatureService,
    MpApiClient,
    MpTokenService,
    MpAccountsService,
    PaymentIntentsService,
  ],
  exports: [
    MpConfigService,
    MpCryptoService,
    MpSignatureService,
    MpApiClient,
    MpTokenService,
    MpAccountsService,
    PaymentIntentsService,
  ],
})
export class MercadoPagoModule {}
