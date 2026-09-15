import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { MembershipRole } from '@prisma/client';
import { ENTITY_ROLE_KEY } from '../auth/decorators/entity-role.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { OccupancyResponseDto } from './dto/occupancy-response.dto';
import { PaymentMethodBreakdownDto } from './dto/payment-method-breakdown.dto';
import { RevenueResponseDto } from './dto/revenue-response.dto';
import { MetricsSummaryDto } from './dto/summary-response.dto';
import { TopPlatesResponseDto } from './dto/top-plates-response.dto';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

describe('MetricsController', () => {
  let controller: MetricsController;

  const mockMetricsService = {
    getSummary: jest.fn(),
    getRevenue: jest.fn(),
    getPaymentMethodBreakdown: jest.fn(),
    getTopPlates: jest.fn(),
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
    it.each([
      ['getSummary'],
      ['getRevenue'],
      ['getPaymentMethodBreakdown'],
      ['getTopPlates'],
      ['getOccupancy'],
    ])('%s requires the owner entity role', (handler) => {
      const role = reflector.get<MembershipRole>(
        ENTITY_ROLE_KEY,
        MetricsController.prototype[handler as keyof MetricsController],
      );

      expect(role).toBe(MembershipRole.owner);
    });
  });

  describe('delegation', () => {
    // The controller is a pass-through, so these assert only that each handler
    // reaches its service method with the query untouched. Stubs are partial
    // responses cast to shape — the real payloads are covered in the service
    // spec, and duplicating them here would only couple the two.
    const stub = <T>(value: unknown): T => value as T;

    it('passes the timezone query through to the service', async () => {
      const query = { tz: 'UTC' };
      mockMetricsService.getSummary.mockResolvedValue(
        stub<MetricsSummaryDto>({ tz: 'UTC' }),
      );

      const result = await controller.getSummary(query);

      expect(mockMetricsService.getSummary).toHaveBeenCalledWith(query);
      expect(result.tz).toBe('UTC');
    });

    it('passes the revenue window and filters through untouched', async () => {
      const query = {
        from: '2026-08-07T13:00:00-03:00',
        to: '2026-08-10T13:00:00-03:00',
        granularity: 'day' as const,
        paymentMethod: 'Efectivo',
      };
      mockMetricsService.getRevenue.mockResolvedValue(
        stub<RevenueResponseDto>({ currency: 'ARS' }),
      );

      await controller.getRevenue(query);

      expect(mockMetricsService.getRevenue).toHaveBeenCalledWith(query);
    });

    it('passes the breakdown window through to the service', async () => {
      const query = {
        from: '2026-08-07T13:00:00-03:00',
        to: '2026-08-10T13:00:00-03:00',
      };
      mockMetricsService.getPaymentMethodBreakdown.mockResolvedValue(
        stub<PaymentMethodBreakdownDto>({ total: 0 }),
      );

      await controller.getPaymentMethodBreakdown(query);

      expect(mockMetricsService.getPaymentMethodBreakdown).toHaveBeenCalledWith(
        query,
      );
    });

    it('passes the top-plates ranking options through to the service', async () => {
      const query = {
        from: '2026-08-07T13:00:00-03:00',
        to: '2026-08-10T13:00:00-03:00',
        orderBy: 'visits' as const,
        limit: 5,
      };
      mockMetricsService.getTopPlates.mockResolvedValue(
        stub<TopPlatesResponseDto>({ items: [] }),
      );

      await controller.getTopPlates(query);

      expect(mockMetricsService.getTopPlates).toHaveBeenCalledWith(query);
    });

    it('exposes occupancy without any query parameter', async () => {
      mockMetricsService.getOccupancy.mockResolvedValue(
        stub<OccupancyResponseDto>({ capacity: 100 }),
      );

      const result = await controller.getOccupancy();

      expect(mockMetricsService.getOccupancy).toHaveBeenCalledWith();
      expect(result.capacity).toBe(100);
    });
  });
});
