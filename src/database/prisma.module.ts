import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TenantContextService } from './tenant-context.service';
import { TenantInterceptor } from './tenant.interceptor';

@Global()
@Module({
  providers: [PrismaService, TenantContextService, TenantInterceptor],
  exports: [PrismaService, TenantContextService, TenantInterceptor],
})
export class PrismaModule {}
