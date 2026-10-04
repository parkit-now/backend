import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { MembershipRole } from '@prisma/client';
import { EntityRole } from '../auth/decorators/entity-role.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { ProblemDetailsDto } from '../utils/exceptions/dto/problem-details.dto';
import { TenantInterceptor } from '../database/tenant.interceptor';
import {
  ReservationHoursDto,
  ReservationNotReadyProblemDto,
} from './dto/reservation-hours.dto';
import { ServiceCatalogItemDto } from './dto/service-catalog-item.dto';
import { ServiceChangesQueryDto } from './dto/service-changes-query.dto';
import { ServiceChangesResponseDto } from './dto/service-changes-response.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { ServicesService } from './services.service';

@ApiTags('Services')
@Controller('tenants/:tenantId/services')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('bearer')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Get()
  @ApiOperation({
    summary: 'List the service catalog with the tenant enabled state',
  })
  @ApiOkResponse({ type: [ServiceCatalogItemDto] })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async findAll() {
    return this.servicesService.listServices();
  }

  @Get('changes')
  @ApiOperation({ summary: 'Pull incremental changes for offline sync' })
  @ApiOkResponse({ type: ServiceChangesResponseDto })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async pullChanges(@Query() query: ServiceChangesQueryDto) {
    return this.servicesService.pullChanges(query);
  }

  @Patch(':code')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    summary:
      'Update a service for the active tenant (ADVANCE_RESERVATION also takes the reservation rate and reservable spots)',
  })
  @ApiOkResponse({ type: ServiceCatalogItemDto })
  @ApiUnprocessableEntityResponse({
    type: ReservationNotReadyProblemDto,
    description:
      'SERVICE_RESERVATION_NOT_READY: se intentó activar las reservas sin ' +
      'cumplir los requisitos; `missing` los lista.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  @ApiParam({ name: 'code', description: 'Service code (ServiceCode enum)' })
  async update(@Param('code') code: string, @Body() dto: UpdateServiceDto) {
    return this.servicesService.updateService(code, {
      enabled: dto.enabled,
      reservationRateId: dto.reservationRateId,
      reservableSpots: dto.reservableSpots,
      reservationVehicleCategories: dto.reservationVehicleCategories,
      acceptanceMode: dto.acceptanceMode,
      approvalWindowMinutes: dto.approvalWindowMinutes,
      freeCancelMinutes: dto.freeCancelMinutes,
      lateCancelRefundPct: dto.lateCancelRefundPct,
      earlyArrivalMinutes: dto.earlyArrivalMinutes,
      graceMinutes: dto.graceMinutes,
      earlyArrivalMaxMinutes: dto.earlyArrivalMaxMinutes,
    });
  }

  // Rutas literales (ADVANCE_RESERVATION) y no `:code/hours`: el horario de
  // reservas sólo existe para ese servicio.
  @Get('ADVANCE_RESERVATION/hours')
  @ApiOperation({
    summary: 'Reservation hours: mode (opening | custom) and custom ranges',
  })
  @ApiOkResponse({ type: ReservationHoursDto })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async getReservationHours() {
    return this.servicesService.getReservationHours();
  }

  @Put('ADVANCE_RESERVATION/hours')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    summary:
      'Replace the whole reservation hours set (ranges must fall within the opening hours)',
  })
  @ApiOkResponse({ type: ReservationHoursDto })
  @ApiUnprocessableEntityResponse({
    type: ProblemDetailsDto,
    description:
      'RESERVATION_HOURS_OUTSIDE_OPENING: algún rango no cae dentro del horario de apertura.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async putReservationHours(@Body() dto: ReservationHoursDto) {
    return this.servicesService.putReservationHours(dto);
  }
}
