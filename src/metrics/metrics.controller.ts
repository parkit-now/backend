import {
  Controller,
  Get,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { MembershipRole } from '@prisma/client';
import { EntityRole } from '../auth/decorators/entity-role.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import {
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
} from '../utils/exceptions/dto/problem-details.dto';
import { MetricsTzQueryDto } from './dto/metrics-tz-query.dto';
import { OccupancyResponseDto } from './dto/occupancy-response.dto';
import { RevenueQueryDto } from './dto/revenue-query.dto';
import { RevenueResponseDto } from './dto/revenue-response.dto';
import { MetricsSummaryDto } from './dto/summary-response.dto';
import { MetricsService } from './metrics.service';

/**
 * Owner dashboard metrics for a single parking lot.
 *
 * There is no cross-tenant surface here on purpose: an owner with several lots
 * reads their memberships from `GET /auth/me`, calls this controller once per
 * lot and merges client-side. That keeps every metrics read behind the same
 * `/tenants/:tenantId` + guard + interceptor path as the rest of the API.
 *
 * `@EntityRole` is applied per handler rather than on the class so an endpoint
 * can later be opened to `operator` by dropping one decorator.
 */
@ApiTags('Metrics')
@Controller('tenants/:tenantId/metrics')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('bearer')
@ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
@ApiForbiddenResponse({
  description:
    'Caller is an `operator` (`ENTITY_INSUFFICIENT_ROLE`) or has no membership in this lot (`ENTITY_NO_ACCESS`).',
  type: ProblemDetailsDto,
})
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get('summary')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    operationId: 'metricsGetSummary',
    summary: 'Owner dashboard KPIs in a single call',
    description: [
      'Returns live occupancy, today’s revenue and vehicle counts, the day-over-day and week-over-week comparison, and the pending-alert count.',
      '',
      'Civil days are delimited in `tz` (defaults to Argentina). Both baselines are truncated to the same elapsed offset within the day as today has run so far, so the deltas stay meaningful at any hour.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: MetricsSummaryDto })
  async getSummary(
    @Query() query: MetricsTzQueryDto,
  ): Promise<MetricsSummaryDto> {
    return this.metricsService.getSummary(query);
  }

  @Get('revenue')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    operationId: 'metricsGetRevenue',
    summary: 'Revenue and vehicle counts over a window, bucketed',
    description: [
      'Time series behind the revenue dashboard. `from`/`to` describe one continuous interval (not a repeating daily window), and the first and last buckets are clipped to the exact instants requested.',
      '',
      'Both the money series and the vehicle-count series come back together, so the dashboard’s $/cars toggle needs no second request. Note they use different time anchors — see `totals`.',
      '',
      'Optional filters narrow to a payment method or a vehicle type; `paymentMethod` switches the revenue source, reported in `revenueSource`.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: RevenueResponseDto })
  @ApiBadRequestResponse({
    description:
      '`from` is not before `to`, a date-time lacks an explicit offset, or the range and granularity together exceed the bucket limit.',
    type: ValidationProblemDetailsDto,
  })
  async getRevenue(
    @Query() query: RevenueQueryDto,
  ): Promise<RevenueResponseDto> {
    return this.metricsService.getRevenue(query);
  }

  @Get('occupancy')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    operationId: 'metricsGetOccupancy',
    summary: 'Current occupancy of the lot',
    description: [
      'Occupied spots over total capacity right now, plus a breakdown of open entries by vehicle type.',
      '',
      'Capacity comes from the enabled `services.spots`, falling back to the profile `settings.capacity`; `capacitySource` reports which one was used. The breakdown is best effort — see `byVehicleType`.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: OccupancyResponseDto })
  async getOccupancy(): Promise<OccupancyResponseDto> {
    return this.metricsService.getOccupancy();
  }
}
