import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { ZoneDto } from '../generated/nestjs-dto/zone.dto';
import {
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
} from '../utils/exceptions/dto/problem-details.dto';
import { CreateZoneDto } from './dto/create-zone.dto';
import { UpdateZoneDto } from './dto/update-zone.dto';
import { ZonesService } from './zones.service';

@ApiTags('Zones')
@ApiExtraModels(ProblemDetailsDto, ValidationProblemDetailsDto, ZoneDto)
// Tenant-local: routes depend on the tenant (parking lot).
@Controller('tenants/:tenantId/zones')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('bearer')
@ApiParam({
  name: 'tenantId',
  format: 'uuid',
  description: 'ID of the parking lot (tenant) the zone belongs to.',
})
@ApiUnauthorizedResponse({
  description: 'Missing, malformed, or expired bearer token.',
  type: ProblemDetailsDto,
})
@ApiForbiddenResponse({
  description:
    'The caller is authenticated but is not a member of the `:tenantId` parking lot, so its zones are out of reach.',
  type: ProblemDetailsDto,
})
export class ZonesController {
  constructor(private readonly zonesService: ZonesService) {}

  @Get()
  @ApiOperation({
    operationId: 'zonesList',
    summary: 'List the zones of a parking lot',
    description: [
      'Returns every zone configured for the `:tenantId` parking lot, ordered by creation date.',
      '',
      'A **zone** groups parking spot counts by vehicle type (`carSpots`, `motorcycleSpots`, `bicycleSpots`) inside a single parking lot. It models configuration only — the individual operational spot is out of scope here.',
      '',
      '**Tenant isolation:** the response only contains zones of parking lots the caller belongs to; zones of other lots are never returned.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: ZoneDto, isArray: true })
  async findAll() {
    return this.zonesService.findAll();
  }

  @Post()
  @ApiOperation({
    operationId: 'zonesCreate',
    summary: 'Create a zone in a parking lot',
    description: [
      'Creates a new zone in the `:tenantId` parking lot with its per-vehicle-type spot counts (`carSpots`, `motorcycleSpots`, `bicycleSpots`). Any count omitted from the payload defaults to `0`.',
      '',
      'A **zone** is configuration only: it declares how many spots of each vehicle type the lot offers, not the individual operational spots.',
      '',
      '**Tenant isolation:** the zone is bound to the `:tenantId` the caller is operating on; the tenant is injected automatically and is never part of the request body.',
    ].join('\n'),
  })
  @ApiCreatedResponse({ type: ZoneDto })
  @ApiBadRequestResponse({
    description:
      'Invalid payload (missing name, negative or non-integer spot counts, etc.).',
    type: ValidationProblemDetailsDto,
  })
  async create(@Body() dto: CreateZoneDto) {
    return this.zonesService.create(dto);
  }

  @Patch(':id')
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'ID of the zone to update.',
  })
  @ApiOperation({
    operationId: 'zonesUpdate',
    summary: 'Update a zone of a parking lot',
    description: [
      'Partially updates a zone of the `:tenantId` parking lot. Only the provided fields are changed; the `name` and the per-vehicle-type spot counts (`carSpots`, `motorcycleSpots`, `bicycleSpots`) can be adjusted.',
      '',
      'A **zone** is configuration only — it groups spot counts by vehicle type and does not model individual operational spots.',
      '',
      '**Tenant isolation:** only zones belonging to a parking lot the caller is a member of can be updated; zones of other lots are reported as not found.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: ZoneDto })
  @ApiBadRequestResponse({
    description: 'Invalid payload (negative or non-integer spot counts, etc.).',
    type: ValidationProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description:
      'No zone with `:id` exists within the `:tenantId` parking lot (`ZONE_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  async update(@Param('id') id: string, @Body() dto: UpdateZoneDto) {
    return this.zonesService.update(id, dto);
  }

  @Delete(':id')
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'ID of the zone to delete.',
  })
  @ApiOperation({
    operationId: 'zonesRemove',
    summary: 'Delete a zone of a parking lot',
    description: [
      'Deletes a zone from the `:tenantId` parking lot and returns the `id` of the removed zone.',
      '',
      'A **zone** is configuration only — removing it drops the per-vehicle-type spot counts it grouped, without touching individual operational spots.',
      '',
      '**Tenant isolation:** only zones belonging to a parking lot the caller is a member of can be deleted; zones of other lots are reported as not found.',
    ].join('\n'),
  })
  @ApiOkResponse({
    description:
      'The zone was deleted; the response carries the deleted zone `id`.',
  })
  @ApiNotFoundResponse({
    description:
      'No zone with `:id` exists within the `:tenantId` parking lot (`ZONE_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  async remove(@Param('id') id: string) {
    return this.zonesService.remove(id);
  }
}
