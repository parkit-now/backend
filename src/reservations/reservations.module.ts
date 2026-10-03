import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { OwnerReservationsController } from './owner-reservations.controller';
import { OwnerReservationsService } from './owner-reservations.service';
import { ReservationPaymentGatewayProvider } from './payment-gateway/reservation-payment.provider';
import { RESERVATION_PAYMENT_GATEWAY } from './payment-gateway/reservation-payment-gateway';
import { ReservationLifecycleService } from './reservation-lifecycle.service';
import { ReservationSweeperService } from './reservation-sweeper.service';

/**
 * Núcleo de las reservas con pago: ciclo de vida, barrido y puerto del cobro.
 * Exporta el ciclo de vida y el gateway para la API del conductor, la del
 * dueño y (fase 3) el webhook de Mercado Pago.
 */
@Module({
  imports: [PrismaModule],
  controllers: [OwnerReservationsController],
  providers: [
    OwnerReservationsService,
    ReservationPaymentGatewayProvider,
    ReservationLifecycleService,
    ReservationSweeperService,
  ],
  exports: [ReservationLifecycleService, RESERVATION_PAYMENT_GATEWAY],
})
export class ReservationsModule {}
