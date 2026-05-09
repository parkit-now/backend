import { Test, TestingModule } from '@nestjs/testing';
import { EntriesController } from './entries.controller';
import { EntriesService } from './entries.service';
import { PrismaService } from '../database/prisma.service';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { TenantContextService } from '../database/tenant-context.service';

describe('EntriesController', () => {
  let controller: EntriesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EntriesController],
      providers: [
        {
          provide: EntriesService,
          useValue: {},
        },
        {
          provide: PrismaService,
          useValue: {},
        },
        TenantContextService,
        TenantInterceptor,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(TenantMembershipGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<EntriesController>(EntriesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
