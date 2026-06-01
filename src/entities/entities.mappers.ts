import type { PaymentMethod, Tenant } from '@prisma/client';
import {
  EntityProfileDto,
  PaymentMethodSummaryDto,
} from './dto/entity-profile.dto';

export function toPaymentMethodDto(pm: PaymentMethod): PaymentMethodSummaryDto {
  return {
    id: pm.id,
    type: pm.type,
    name: pm.name,
    enabled: pm.enabled,
    isDefault: pm.isDefault,
    isSystem: pm.isSystem,
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
    status: tenant.status,
    paymentMethods: paymentMethods.map(toPaymentMethodDto),
    createdAt: tenant.createdAt.toISOString(),
  };
}
