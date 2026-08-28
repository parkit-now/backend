import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { MembershipRole } from '@prisma/client';
import { ENTITY_ROLE_KEY } from '../auth/decorators/entity-role.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

describe('MetricsController', () => {
  let controller: MetricsController;

  const mockMetricsService = {
    getSummary: jest.fn(),
    getOccupancy: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [
        { provide: MetricsService, useValue: mockMetricsService },
        { provide: PrismaService, useValue: {} },
        TenantContextService,
        TenantInterceptor,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(TenantMembershipGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<MetricsController>(MetricsController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('owner gating', () => {
    const reflector = new Reflector();

    // The guard reads this metadata to enforce the role. If a handler ever
    // loses the decorator, operators silently gain access to the owner's
    // business figures — so assert it per handler rather than trusting review.
    it.each([['getSummary'], ['getOccupancy']])(
      '%s requires the owner entity role',
      (handler) => {
        const role = reflector.get<MembershipRole>(
          ENTITY_ROLE_KEY,
          MetricsController.prototype[handler as keyof MetricsController],
        );

        expect(role).toBe(MembershipRole.owner);
      },
    );
  });

  describe('delegation', () => {
    it('passes the timezone query through to the service', async () => {
      const query = { tz: 'UTC' };
      mockMetricsService.getSummary.mockResolvedValue({ tz: 'UTC' });

      const result = await controller.getSummary(query);

      expect(mockMetricsService.getSummary).toHaveBeenCalledWith(query);
      expect(result).toEqual({ tz: 'UTC' });
    });

    it('exposes occupancy without any query parameter', async () => {
      mockMetricsService.getOccupancy.mockResolvedValue({ capacity: 100 });

      const result = await controller.getOccupancy();

      expect(mockMetricsService.getOccupancy).toHaveBeenCalledWith();
      expect(result).toEqual({ capacity: 100 });
    });
  });
});
