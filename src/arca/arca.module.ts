import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../database/prisma.module';
import { ArcaAccountsController } from './arca-accounts.controller';
import { ArcaSelectedAccountsController } from './arca-selected-accounts.controller';
import { ArcaAccountsService } from './arca-accounts.service';
import { ArcaConfigService } from './arca-config.service';
import { ArcaCryptoService } from './arca-crypto.service';
import { ArcaMaintenanceService } from './arca-maintenance.service';
import { ArcaSdkGateway } from './arca-sdk.gateway';
import { ARCA_GATEWAY } from './arca.gateway';
import { InvoiceDocumentService } from './invoice-document.service';
import { InvoiceReceiversService } from './invoice-receivers.service';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

/**
 * Facturación electrónica con ARCA. Sin `ARCA_ENV` queda apagada (ver
 * `ArcaConfigService`): el resto de la app no se entera.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [
    ArcaAccountsController,
    ArcaSelectedAccountsController,
    InvoicesController,
  ],
  providers: [
    ArcaConfigService,
    ArcaCryptoService,
    { provide: ARCA_GATEWAY, useClass: ArcaSdkGateway },
    InvoicesService,
    InvoiceReceiversService,
    InvoiceDocumentService,
    ArcaAccountsService,
    ArcaMaintenanceService,
  ],
  // `ArcaAccountsService` sale para que el borrado de estacionamiento pueda
  // desvincular ARCA (`ParkingDeletionService`).
  exports: [
    ArcaConfigService,
    ArcaCryptoService,
    InvoicesService,
    ArcaAccountsService,
  ],
})
export class ArcaModule {}
