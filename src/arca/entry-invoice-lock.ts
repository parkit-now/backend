import type { Prisma } from '@prisma/client';

/** Corrections and invoice claims must agree before any request reaches ARCA. */
export async function lockEntryInvoice(
  tx: Prisma.TransactionClient,
  tenantId: string,
  entryId: string,
): Promise<void> {
  const key = `entry-invoice:${tenantId}:${entryId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}
