import { Test, TestingModule } from '@nestjs/testing';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { RatesController } from './rates.controller';
import { RatesService } from './rates.service';

describe('RatesController', () => {
  let controller: RatesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RatesController],
      providers: [
        {
          provide: RatesService,
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
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<RatesController>(RatesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
