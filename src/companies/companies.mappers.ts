import type { PaymentMethod, Prisma } from '@prisma/client';
import { BranchDto, PaymentMethodSummaryDto } from './dto/company-config.dto';

type TenantWithZones = Prisma.TenantGetPayload<{ include: { zones: true } }>;

export function toBranchDto(tenant: TenantWithZones): BranchDto {
  const carSpots = tenant.zones.reduce((acc, z) => acc + z.carSpots, 0);
  const motorcycleSpots = tenant.zones.reduce(
    (acc, z) => acc + z.motorcycleSpots,
    0,
  );
  const bicycleSpots = tenant.zones.reduce((acc, z) => acc + z.bicycleSpots, 0);
  return {
    id: tenant.id,
    name: tenant.name,
    address: tenant.address,
    status: tenant.status,
    totalSpots: carSpots + motorcycleSpots + bicycleSpots,
    carSpots,
    motorcycleSpots,
    bicycleSpots,
    occupancyPct: 0,
    managerName: '',
  };
}

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
