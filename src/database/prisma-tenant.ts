import { PrismaClient } from '@prisma/client';

/**
 * Tenant-scoped Prisma client factory.
 *
 * Two layers of defense for multi-tenant isolation:
 *   1. This extension (application layer): always active when callers use
 *      `prismaForTenant(...)` instead of the raw client.
 *   2. Postgres RLS (database layer): active when the underlying connection
 *      uses a Supabase JWT (i.e. PostgREST / supabase-js). The Prisma
 *      service-role connection bypasses RLS, which is exactly why this
 *      extension exists.
 *
 * Per-operation contract (applied to every model in `TENANT_MODELS`):
 *   READ           → injects `WHERE tenantId` automatically.
 *   CREATE         → asserts `data.tenantId` matches the scope or is unset.
 *   UPDATE/DELETE  → throws if `where.tenantId` is missing (forces
 *                    explicitness; never silently fans out across tenants).
 *   UPSERT         → same as UPDATE/DELETE.
 *
 * Models without a `tenant_id` column (e.g. `Tenant`, `User`,
 * `UserMembership`) are passthrough.
 *
 * `User` no longer carries `tenant_id`; the link lives in
 * `user_memberships`. `UserMembership` is intentionally NOT scoped — it is
 * a cross-tenant join table and legitimate flows (e.g. "list every parking
 * lot this user belongs to", which an owner with several lots needs)
 * require reading across tenants under explicit admin control.
 *
 * Right now there are no business tables with `tenant_id` yet, so
 * `TENANT_MODELS` is empty and this extension is a passthrough. Add new
 * tenant-scoped business models to the list as they appear.
 */

const TENANT_MODELS: readonly string[] = ['entry'];

const READ_OPS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

const CREATE_OPS = new Set(['create', 'createMany']);

export function prismaForTenant(prisma: PrismaClient, tenantId: string) {
  if (!tenantId) {
    throw new Error(
      '[prismaForTenant] tenantId is required. Refusing to build a client without tenant context.',
    );
  }

  return prisma.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const modelName = model?.toLowerCase() ?? '';
          if (!TENANT_MODELS.includes(modelName)) {
            return query(args);
          }

          if (READ_OPS.has(operation)) {
            const readArgs = args as { where?: Record<string, unknown> };
            return query({
              ...args,
              where: { ...readArgs.where, tenantId },
            });
          }

          if (CREATE_OPS.has(operation)) {
            const createArgs = args as {
              data?: Record<string, unknown> | Record<string, unknown>[];
            };

            if (Array.isArray(createArgs.data)) {
              for (const row of createArgs.data) {
                assertTenantMatch(row, tenantId, model, operation);
              }
            } else if (createArgs.data) {
              assertTenantMatch(createArgs.data, tenantId, model, operation);
            }

            return query(args);
          }

          const mutArgs = args as { where?: Record<string, unknown> };
          if (!mutArgs.where?.tenantId) {
            throw new Error(
              `[prismaForTenant] ${model}.${operation} called without tenantId in where. ` +
                'This would operate across all tenants. ' +
                'Use: where: { tenantId, ...otherFilters }',
            );
          }

          return query(args);
        },
      },
    },
  });
}

function assertTenantMatch(
  data: Record<string, unknown>,
  tenantId: string,
  model: string | undefined,
  operation: string,
): void {
  if (data.tenantId !== undefined && data.tenantId !== tenantId) {
    throw new Error(
      `[prismaForTenant] wrong tenantId in ${model}.${operation}: ` +
        `received ${JSON.stringify(data.tenantId)}, expected '${tenantId}'. ` +
        'Cross-tenant writes are forbidden.',
    );
  }
}
