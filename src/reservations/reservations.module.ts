import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { MercadoPagoModule } from '../mercado-pago/mercado-pago.module';
import { DevCheckoutController } from './dev-checkout.controller';
import { resolveReservationPaymentProvider } from './payment-gateway/reservation-payment.provider';
import { MpReturnController } from './mp-return.controller';
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
  // `MercadoPagoModule` da el cliente de la API y los tokens del gateway de
  // Checkout Pro. No importa a este módulo (el webhook de pagos vive aparte).
  imports: [PrismaModule, MercadoPagoModule],
  controllers: [
    OwnerReservationsController,
    // Página puente de Checkout Pro: siempre registrada (inofensiva sin MP).
    MpReturnController,
    // Sólo con el proveedor `dev` (nunca en producción: ver el proveedor).
    ...(resolveReservationPaymentProvider() === 'dev'
      ? [DevCheckoutController]
      : []),
  ],
  providers: [
    OwnerReservationsService,
    ReservationPaymentGatewayProvider,
    ReservationLifecycleService,
    ReservationSweeperService,
  ],
  exports: [ReservationLifecycleService, RESERVATION_PAYMENT_GATEWAY],
})
export class ReservationsModule {}
