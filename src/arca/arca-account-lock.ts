import type { Prisma } from '@prisma/client';

/** Serializes account lifecycle and invoice claims within a parking lot. */
export async function lockArcaAccounts(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`arca-accounts:${tenantId}`}))`;
}
