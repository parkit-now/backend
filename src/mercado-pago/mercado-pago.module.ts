import { Module } from '@nestjs/common';
import { MpConfigService } from './mp-config.service';
import { MpCryptoService } from './mp-crypto.service';
import { MpSignatureService } from './mp-signature.service';

/**
 * Cimientos de la integración con Mercado Pago: configuración validada al
 * boot, cifrado de tokens y verificación de firma de webhooks. Sin red y sin
 * estado: son las piezas que van a consumir el OAuth (B2) y el webhook (B4).
 *
 * `ConfigService` llega por el `ConfigModule.forRoot({ isGlobal: true })` de
 * `AppModule`, igual que en `StorageModule`.
 *
 * ## Por qué todavía NO está en `app.module.ts`
 *
 * `MpConfigService` valida el entorno con `getOrThrow` en `onModuleInit`, o
 * sea que sin las `MP_*` el proceso no levanta. Eso es exactamente lo que
 * queremos cuando haya cobros de por medio, y exactamente lo que no queremos
 * hoy: todavía no hay un solo endpoint que las use, así que registrarlo ahora
 * es todo costo y cero beneficio.
 *
 * Se verificó a mano, no se asumió:
 *
 *  - Registrarlo NO rompe la suite: ningún spec levanta `AppModule` (todos
 *    arman sus providers a mano), así que `bun test` queda igual de verde.
 *  - Pero el `.env.example` recién ahora documenta estas variables: un
 *    entorno que no las tenga —CI si algún día bootea, staging, Cloud Run, o
 *    la máquina de cualquiera que haga `git pull` sin tocar su `.env`— deja
 *    de arrancar entero, no sólo la parte de Mercado Pago.
 *
 * Y hay una trampa: quien tenga las `MP_*` en su `.env` local NO va a ver el
 * problema, con lo cual el que registra es el único al que le funciona. Por
 * eso se registra en B2, en el mismo commit que agregue el controller de
 * OAuth y sume las variables a `make env-check`: ahí el fail-fast protege
 * algo real y la falta de configuración se detecta antes de desplegar.
 */
@Module({
  providers: [MpConfigService, MpCryptoService, MpSignatureService],
  exports: [MpConfigService, MpCryptoService, MpSignatureService],
})
export class MercadoPagoModule {}
