import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../database/prisma.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { MercadoPagoModule } from './mercado-pago.module';
import { MpWebhookController } from './mp-webhook.controller';
import { MpWebhookService } from './mp-webhook.service';

/**
 * Webhook público de Mercado Pago: órdenes de QR y pagos de reservas.
 *
 * Vive aparte de `MercadoPagoModule` para no hacer un ciclo: necesita el ciclo
 * de vida y el gateway de `ReservationsModule`, y éste ya importa a
 * `MercadoPagoModule`. Éste importa a los dos y nadie lo importa a él.
 */
@Module({
  imports: [PrismaModule, AuditModule, MercadoPagoModule, ReservationsModule],
  controllers: [MpWebhookController],
  providers: [MpWebhookService],
})
export class MpWebhookModule {}
