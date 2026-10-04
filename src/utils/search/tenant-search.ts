import type { Prisma } from '@prisma/client';

/**
 * Case-insensitive search of a parking lot by name or address. Shared by the
 * admin listing and the driver's search by name. An empty term matches
 * everything; callers that must not (the driver) validate the length first.
 */
export function tenantSearchWhere(search?: string): Prisma.TenantWhereInput {
  const term = search?.trim();
  if (!term) return {};
  return {
    OR: [
      { name: { contains: term, mode: 'insensitive' } },
      { address: { contains: term, mode: 'insensitive' } },
    ],
  };
}
