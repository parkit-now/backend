import type { PaymentMethod, Tenant } from '@prisma/client';
import {
  EntityProfileDto,
  PaymentMethodSummaryDto,
} from './dto/entity-profile.dto';
import {
  readCapacity,
  readDesktopCameraConfig,
  readTicketTemplate,
} from './entity-settings';
import { toEntityAddressDto } from './tenant-address';

export function toPaymentMethodDto(pm: PaymentMethod): PaymentMethodSummaryDto {
  return {
    id: pm.id,
    type: pm.type,
    name: pm.name,
    enabled: pm.enabled,
    isDefault: pm.isDefault,
    invoiceMode: pm.invoiceMode,
    isSystem: pm.isSystem,
    syncSeq: pm.syncSeq,
    version: pm.version,
    updatedAt: pm.updatedAt.toISOString(),
    createdAt: pm.createdAt.toISOString(),
    // Viaja SIEMPRE, incluso nulo: es el tombstone. Un cliente que estuvo
    // offline se entera de la baja porque el feed le manda esta fila con la
    // fecha puesta; sin el campo no tendría cómo distinguirla de una viva.
    deletedAt: pm.deletedAt ? pm.deletedAt.toISOString() : null,
  };
}

export function toEntityProfileDto(
  tenant: Tenant,
  paymentMethods: PaymentMethod[],
): EntityProfileDto {
  return {
    id: tenant.id,
    name: tenant.name,
    legalName: tenant.legalName,
    cuit: tenant.cuit,
    email: tenant.email,
    phone: tenant.phone,
    address: tenant.address,
    location: toEntityAddressDto(tenant),
    status: tenant.status,
    capacity: readCapacity(tenant.settings),
    ticketTemplate: readTicketTemplate(tenant.settings),
    desktopCameraConfig: readDesktopCameraConfig(tenant.settings),
    lprImageRetentionDays: tenant.lprImageRetentionDays,
    entryCameraId: tenant.entryCameraId,
    entryCameraLabel: tenant.entryCameraLabel,
    paymentMethods: paymentMethods.map(toPaymentMethodDto),
    createdAt: tenant.createdAt.toISOString(),
  };
}
