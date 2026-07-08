import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './database/prisma.module';
import { HealthModule } from './health/health.module';
import { UsersModule } from './users/users.module';
import { TenantsModule } from './tenants/tenants.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { EntriesModule } from './entries/entries.module';
import { PasswordRecoveryModule } from './password-recovery/password-recovery.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { ApplicationsModule } from './admin/applications/applications.module';
import { ParkingsModule } from './admin/parkings/parkings.module';
import { AdminUsersModule } from './admin/users/admin-users.module';
import { EntitiesModule } from './entities/entities.module';
import { RatesModule } from './rates/rates.module';
import { SchedulesModule } from './schedules/schedules.module';
import { ServicesModule } from './services/services.module';
import { CashSessionsModule } from './cash-sessions/cash-sessions.module';
import { PaymentTransactionsModule } from './payment-transactions/payment-transactions.module';
import { LprEventsModule } from './lpr-events/lpr-events.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    UsersModule,
    AuthModule,
    PasswordRecoveryModule,
    HealthModule,
    TenantsModule,
    VehiclesModule,
    EntriesModule,
    OnboardingModule,
    ApplicationsModule,
    ParkingsModule,
    AdminUsersModule,
    EntitiesModule,
    RatesModule,
    SchedulesModule,
    ServicesModule,
    CashSessionsModule,
    PaymentTransactionsModule,
    LprEventsModule,
  ],
})
export class AppModule {}
