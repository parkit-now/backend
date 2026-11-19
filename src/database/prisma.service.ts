import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { prismaForTenant, TenantPrismaClient } from './prisma-tenant';
import { TenantContextService } from './tenant-context.service';
import { databasePoolConfig } from './database-pool.config';

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
  private readonly logger = new Logger(PrismaService.name);

  constructor(private readonly tenantContext: TenantContextService) {
    const pool = new Pool(databasePoolConfig());
    super({ adapter: new PrismaPg(pool) });
    this.pool = pool;
    // Un socket ocioso puede fallar sin estar asociado a una solicitud HTTP.
    pool.on('error', () => {
      this.logger.error(
        `Database idle connection failed (total=${pool.totalCount}, idle=${pool.idleCount}, waiting=${pool.waitingCount})`,
      );
    });
  }

  /**
   * Returns a Prisma client scoped to the current tenant in context.
   * For tenant-scoped operations, use `getTenantClient()`.
   */
  getTenantClient(): TenantPrismaClient {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    return prismaForTenant(this, tenantId);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log(
      `Database pool ready (max=${this.pool.options.max}, connectTimeoutMs=${this.pool.options.connectionTimeoutMillis}, idleTimeoutMs=${this.pool.options.idleTimeoutMillis})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect();
    } finally {
      await this.pool.end();
    }
  }
}
