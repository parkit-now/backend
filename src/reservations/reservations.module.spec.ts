import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { PrismaService } from '../database/prisma.service';
import { DevCheckoutGateway } from './payment-gateway/dev-checkout.gateway';
import { RESERVATION_PAYMENT_GATEWAY } from './payment-gateway/reservation-payment-gateway';
import { ReservationLifecycleService } from './reservation-lifecycle.service';
import { ReservationSweeperService } from './reservation-sweeper.service';
import { ReservationsModule } from './reservations.module';

describe('ReservationsModule', () => {
  it('resuelve el ciclo de vida, el barrido y el gateway de dev fuera de producción', async () => {
    const previous = process.env.RESERVATION_PAYMENT_PROVIDER;
    delete process.env.RESERVATION_PAYMENT_PROVIDER;
    try {
      const module = await Test.createTestingModule({
        imports: [ReservationsModule],
      })
        .overrideProvider(PrismaService)
        .useValue({})
        .overrideGuard(JwtAuthGuard)
        .useValue({ canActivate: () => true })
        .overrideGuard(TenantMembershipGuard)
        .useValue({ canActivate: () => true })
        .compile();

      expect(module.get(ReservationLifecycleService)).toBeInstanceOf(
        ReservationLifecycleService,
      );
      expect(module.get(ReservationSweeperService)).toBeInstanceOf(
        ReservationSweeperService,
      );
      expect(module.get(RESERVATION_PAYMENT_GATEWAY)).toBeInstanceOf(
        DevCheckoutGateway,
      );
    } finally {
      if (previous === undefined)
        delete process.env.RESERVATION_PAYMENT_PROVIDER;
      else process.env.RESERVATION_PAYMENT_PROVIDER = previous;
    }
  });
});
