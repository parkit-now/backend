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
  ApiNotFoundResponse,
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
import { MetricsWindowQueryDto } from './dto/metrics-window-query.dto';
import { OccupancyResponseDto } from './dto/occupancy-response.dto';
import { PaymentMethodBreakdownDto } from './dto/payment-method-breakdown.dto';
import { RevenueQueryDto } from './dto/revenue-query.dto';
import { RevenueResponseDto } from './dto/revenue-response.dto';
import { TopPlatesQueryDto } from './dto/top-plates-query.dto';
import { TopPlatesResponseDto } from './dto/top-plates-response.dto';
import { MetricsSummaryDto } from './dto/summary-response.dto';
import { MetricsService } from './metrics.service';

/** Shared by every endpoint that takes a window and so a `cashSessionId`. */
const CASH_SESSION_NOT_FOUND_RESPONSE = {
  description:
    '`cashSessionId` does not exist in this parking lot (`CASH_SESSION_NOT_FOUND`). A session of another lot gets the same answer.',
  type: ProblemDetailsDto,
};

/** Shared 400 wording for the window, now that `from`/`to` are conditional. */
const WINDOW_BAD_REQUEST =
  '`from`/`to` missing without a `cashSessionId`, `from` not before `to`, a date-time without an explicit offset, or a malformed `cashSessionId`.';

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
      'Optional filters narrow to a payment method, a vehicle type or a cash session; `paymentMethod` and `cashSessionId` switch the revenue source, reported in `revenueSource`.',
      '',
      'With `cashSessionId` the window may be omitted: it is derived from the shift and widened to cover every payment the shift collected, so the totals are exactly what that drawer took. The window used comes back in `from`/`to`. See the parameter for details.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: RevenueResponseDto })
  @ApiBadRequestResponse({
    description: `${WINDOW_BAD_REQUEST} Also when the range and granularity together exceed the bucket limit.`,
    type: ValidationProblemDetailsDto,
  })
  @ApiNotFoundResponse(CASH_SESSION_NOT_FOUND_RESPONSE)
  async getRevenue(
    @Query() query: RevenueQueryDto,
  ): Promise<RevenueResponseDto> {
    return this.metricsService.getRevenue(query);
  }

  @Get('revenue/by-payment-method')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    operationId: 'metricsGetPaymentMethodBreakdown',
    summary: 'Revenue split by payment method (pie chart)',
    description: [
      'One slice per payment method over the window, largest first.',
      '',
      'Also returns `unallocated`: revenue with no itemised transactions behind it, because the stay was closed through the offline `amountPaid` fallback. Slices plus `unallocated` add up to `total`, so the chart reconciles with the revenue KPI instead of quietly falling short of it.',
      '',
      'With `cashSessionId`: what that shift collected, cash vs. transfer. Every stay of the shift has its payments itemised by construction, so `unallocated` is 0 and `total` matches the revenue series for the same shift.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: PaymentMethodBreakdownDto })
  @ApiBadRequestResponse({
    description: WINDOW_BAD_REQUEST,
    type: ValidationProblemDetailsDto,
  })
  @ApiNotFoundResponse(CASH_SESSION_NOT_FOUND_RESPONSE)
  async getPaymentMethodBreakdown(
    @Query() query: MetricsWindowQueryDto,
  ): Promise<PaymentMethodBreakdownDto> {
    return this.metricsService.getPaymentMethodBreakdown(query);
  }

  @Get('top-plates')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    operationId: 'metricsGetTopPlates',
    summary: 'Highest-value plates over a window',
    description: [
      'Ranks plates by revenue, visit count or time parked — every metric comes back regardless, so switching the ranking is a re-sort rather than another request.',
      '',
      'Counts only stays that ended inside the window: a vehicle still parked has no final amount or duration yet. With `cashSessionId`, only the stays that shift collected.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: TopPlatesResponseDto })
  @ApiBadRequestResponse({
    description: WINDOW_BAD_REQUEST,
    type: ValidationProblemDetailsDto,
  })
  @ApiNotFoundResponse(CASH_SESSION_NOT_FOUND_RESPONSE)
  async getTopPlates(
    @Query() query: TopPlatesQueryDto,
  ): Promise<TopPlatesResponseDto> {
    return this.metricsService.getTopPlates(query);
  }

  @Get('occupancy')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    operationId: 'metricsGetOccupancy',
    summary: 'Current occupancy of the lot',
    description: [
      'Occupied spots over total capacity right now, plus a breakdown of open entries by vehicle type.',
      '',
      'Capacity is the lot-wide total declared on the entity profile (`settings.capacity.total`). The breakdown is best effort — see `byVehicleType`.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: OccupancyResponseDto })
  async getOccupancy(): Promise<OccupancyResponseDto> {
    return this.metricsService.getOccupancy();
  }
}
