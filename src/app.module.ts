import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './database/prisma.module';
import { HealthModule } from './health/health.module';
import { UsersModule } from './users/users.module';
import { TenantsModule } from './tenants/tenants.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { EntriesModule } from './entries/entries.module';
import { PasswordRecoveryModule } from './password-recovery/password-recovery.module';
import { RatesModule } from './rates/rates.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    UsersModule,
    AuthModule,
    PasswordRecoveryModule,
    HealthModule,
    TenantsModule,
    VehiclesModule,
    EntriesModule,
    RatesModule,
  ],
})
export class AppModule {}
