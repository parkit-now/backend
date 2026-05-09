import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { prismaForTenant } from './prisma-tenant';
import { TenantContextService } from './tenant-context.service';

/**
 * NestJS-managed Prisma 7 client.
 *
 * Prisma 7 no longer accepts the connection URL in the schema. The runtime
 * client is built with `@prisma/adapter-pg` and a `pg.Pool` reading
 * `DATABASE_URL` (the pooled URL on Supabase).
 *
 * For tenant-scoped operations, use the `tenant` getter which automatically
 * returns a scoped client based on the current request context.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly pool: Pool;

  constructor(private readonly tenantContext: TenantContextService) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    super({ adapter: new PrismaPg(pool) });
    this.pool = pool;
  }

  /**
   * Returns a Prisma client scoped to the current tenant in context.
   */
  getTenantClient() {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    return prismaForTenant(this, tenantId);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    await this.pool.end();
  }
}
