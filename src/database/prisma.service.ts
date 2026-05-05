import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

/**
 * NestJS-managed Prisma 7 client.
 *
 * Prisma 7 no longer accepts the connection URL in the schema. The runtime
 * client is built with `@prisma/adapter-pg` and a `pg.Pool` reading
 * `DATABASE_URL` (the pooled URL on Supabase).
 *
 * For tenant-scoped operations consumers should NOT use this service
 * directly — they should call `prismaForTenant(prisma, tenantId)` from
 * `./prisma-tenant.ts`, which returns an extended client that injects /
 * validates `tenantId` on every operation.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly pool: Pool;

  constructor() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    super({ adapter: new PrismaPg(pool) });
    this.pool = pool;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    await this.pool.end();
  }
}
