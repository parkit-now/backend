import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
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
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { ExpectedVersionQueryDto } from './dto/expected-version-query.dto';
import { ListVehiclesQueryDto } from './dto/list-vehicles-query.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import {
  VehicleCatalogChangesQueryDto,
  VehicleCatalogChangesResponseDto,
  VehicleCatalogItemDto,
} from './dto/vehicle-catalog.dto';
import { VehiclesService } from './vehicles.service';

@ApiTags('Vehicles')
@Controller('tenants/:tenantId/vehicles')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('bearer')
@ApiParam({
  name: 'tenantId',
  format: 'uuid',
  description: 'ID de la entidad (estacionamiento / tenant).',
})
@ApiUnauthorizedResponse({
  description: 'Missing or invalid bearer token.',
  type: ProblemDetailsDto,
})
@ApiForbiddenResponse({
  description: 'Caller is not a member of the entity, or lacks the role.',
  type: ProblemDetailsDto,
})
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  /**
   * Sin `@EntityRole`: es la MISMA data que ya devuelve `/vehicles/catalog`, que
   * cualquier miembro puede leer porque el autocompletado del desktop la
   * necesita. Cerrar el listado plano dejando abierto el feed de sync sería
   * seguridad de utilería. Las mutaciones sí son owner-only.
   */
  @Get()
  @ApiOperation({
    operationId: 'vehiclesList',
    summary: 'List vehicles available to the entity',
    description:
      'Globales (admin-managed, read-only) + los propios de la entidad, sin ' +
      'bajas lógicas, ordenados por marca y modelo. `tenantId: null` marca los ' +
      'read-only. Disponible para cualquier miembro.',
  })
  @ApiOkResponse({ type: [VehicleCatalogItemDto] })
  list(@Query() query: ListVehiclesQueryDto): Promise<VehicleCatalogItemDto[]> {
    return this.vehicles.listVehicles(query);
  }

  /**
   * `'catalog'` es un literal y no hay ningún `@Get(':vehicleId')`, así que no
   * hay ambigüedad de ruteo. Si algún día se agrega, este handler tiene que ir
   * declarado PRIMERO.
   */
  @Get('catalog')
  @ApiOperation({
    operationId: 'entitiesPullVehicleCatalog',
    summary: 'Pull vehicle catalog changes',
    description:
      'Returns global vehicles (admin-managed) and entity-specific vehicles ' +
      'with syncSeq > afterSeq, INCLUDING soft-deleted rows (non-null ' +
      'deletedAt) so offline clients can drop them. Used by the desktop for ' +
      'offline-first autocomplete.',
  })
  @ApiOkResponse({ type: VehicleCatalogChangesResponseDto })
  pullCatalog(
    @Query() query: VehicleCatalogChangesQueryDto,
  ): Promise<VehicleCatalogChangesResponseDto> {
    return this.vehicles.pullCatalogChanges(query);
  }

  @Post()
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    operationId: 'entitiesCreateTenantVehicle',
    summary: 'Add a vehicle to the entity catalog',
    description:
      'Creates an entity-specific vehicle entry. The global catalog is seeded ' +
      'by the platform and cannot be written through this API. Requires owner role.',
  })
  @ApiCreatedResponse({ type: VehicleCatalogItemDto })
  @ApiBadRequestResponse({ type: ValidationProblemDetailsDto })
  @ApiConflictResponse({
    description: 'VEHICLE_DUPLICATE | VEHICLE_ALREADY_IN_GLOBAL_CATALOG',
    type: ProblemDetailsDto,
  })
  create(@Body() dto: CreateVehicleDto): Promise<VehicleCatalogItemDto> {
    return this.vehicles.createTenantVehicle(dto);
  }

  @Patch(':vehicleId')
  @EntityRole(MembershipRole.owner)
  @ApiParam({
    name: 'vehicleId',
    format: 'uuid',
    description: 'ID of the entity vehicle to update.',
  })
  @ApiOperation({
    operationId: 'entitiesUpdateTenantVehicle',
    summary:
      'Update an entity vehicle using optimistic locking (expectedVersion)',
    description:
      'Updates brand, model and/or type. Global vehicles cannot be edited. ' +
      'Requires owner role.',
  })
  @ApiOkResponse({ type: VehicleCatalogItemDto })
  @ApiBadRequestResponse({ type: ValidationProblemDetailsDto })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  @ApiConflictResponse({
    description:
      'CONFLICT | VEHICLE_DUPLICATE | VEHICLE_ALREADY_IN_GLOBAL_CATALOG',
    type: ProblemDetailsDto,
  })
  update(
    @Param('vehicleId', ParseUUIDPipe) vehicleId: string,
    @Query() query: ExpectedVersionQueryDto,
    @Body() dto: UpdateVehicleDto,
  ): Promise<VehicleCatalogItemDto> {
    return this.vehicles.updateTenantVehicle(
      vehicleId,
      query.expectedVersion,
      dto,
    );
  }

  @Delete(':vehicleId')
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({
    name: 'vehicleId',
    format: 'uuid',
    description: 'ID of the entity vehicle to delete.',
  })
  @ApiOperation({
    operationId: 'entitiesDeleteTenantVehicle',
    summary:
      'Soft-delete an entity vehicle using optimistic locking (expectedVersion)',
    description:
      'Soft-deletes the vehicle (sets deleted_at). The row keeps flowing ' +
      'through GET /vehicles/catalog as a tombstone so offline clients can ' +
      'remove it locally. Global vehicles cannot be deleted. Requires owner role.',
  })
  @ApiNoContentResponse({ description: 'Vehicle deleted.' })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  @ApiConflictResponse({
    description: 'CONFLICT (stale version or already deleted)',
    type: ProblemDetailsDto,
  })
  remove(
    @Param('vehicleId', ParseUUIDPipe) vehicleId: string,
    @Query() query: ExpectedVersionQueryDto,
  ): Promise<void> {
    return this.vehicles.deleteTenantVehicle(vehicleId, query.expectedVersion);
  }
}
