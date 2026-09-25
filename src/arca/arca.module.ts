import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { ArcaConfigService } from './arca-config.service';
import { ArcaCryptoService } from './arca-crypto.service';
import { ArcaSdkGateway } from './arca-sdk.gateway';
import { ARCA_GATEWAY } from './arca.gateway';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

/**
 * Facturación electrónica con ARCA. Sin `ARCA_ENV` queda apagada (ver
 * `ArcaConfigService`): el resto de la app no se entera.
 */
@Module({
  imports: [PrismaModule],
  controllers: [InvoicesController],
  providers: [
    ArcaConfigService,
    ArcaCryptoService,
    { provide: ARCA_GATEWAY, useClass: ArcaSdkGateway },
    InvoicesService,
  ],
  exports: [ArcaConfigService, ArcaCryptoService, InvoicesService],
})
export class ArcaModule {}
