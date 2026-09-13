import type { PaymentMethod, Tenant } from '@prisma/client';
import {
  EntityProfileDto,
  PaymentMethodSummaryDto,
} from './dto/entity-profile.dto';
import { readCapacity } from './entity-settings';
import { toEntityAddressDto } from './tenant-address';

export function toPaymentMethodDto(pm: PaymentMethod): PaymentMethodSummaryDto {
  return {
    id: pm.id,
    type: pm.type,
    name: pm.name,
    enabled: pm.enabled,
    isDefault: pm.isDefault,
    isSystem: pm.isSystem,
    syncSeq: pm.syncSeq,
    version: pm.version,
    updatedAt: pm.updatedAt.toISOString(),
    createdAt: pm.createdAt.toISOString(),
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
    lprImageRetentionDays: tenant.lprImageRetentionDays,
    paymentMethods: paymentMethods.map(toPaymentMethodDto),
    createdAt: tenant.createdAt.toISOString(),
  };
}
