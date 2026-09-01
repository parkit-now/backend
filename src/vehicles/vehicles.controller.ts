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
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import {
  VehicleChangesQueryDto,
  VehicleChangesResponseDto,
  VehicleDto,
} from './dto/vehicle.dto';
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
   * Sin `@EntityRole`: es la MISMA data que ya devuelve `/vehicles/changes`, que
   * cualquier miembro puede leer porque el autocompletado del desktop la
   * necesita. Cerrar el listado plano dejando abierto el feed de sync sería
   * seguridad de utilería. Las mutaciones sí son owner-only.
   */
  @Get()
  @ApiOperation({
    operationId: 'vehiclesList',
    summary: 'List the entity vehicle catalog',
    description:
      'Catálogo del estacionamiento, sin bajas lógicas, ordenado por marca y ' +
      'modelo. Disponible para cualquier miembro.',
  })
  @ApiOkResponse({ type: [VehicleDto] })
  list(): Promise<VehicleDto[]> {
    return this.vehicles.listVehicles();
  }

  /**
   * `'changes'` es un literal y no hay ningún `@Get(':vehicleId')`, así que no
   * hay ambigüedad de ruteo. Si algún día se agrega, este handler tiene que ir
   * declarado PRIMERO.
   */
  @Get('changes')
  @ApiOperation({
    operationId: 'vehiclesPullChanges',
    summary: 'Pull incremental vehicle changes for offline sync',
    description:
      'Returns the entity vehicles with syncSeq > afterSeq, INCLUDING ' +
      'soft-deleted rows (non-null deletedAt) so offline clients can drop ' +
      'them. Used by the desktop for offline-first autocomplete.',
  })
  @ApiOkResponse({ type: VehicleChangesResponseDto })
  pullChanges(
    @Query() query: VehicleChangesQueryDto,
  ): Promise<VehicleChangesResponseDto> {
    return this.vehicles.pullChanges(query);
  }

  @Post()
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    operationId: 'entitiesCreateTenantVehicle',
    summary: 'Add a vehicle to the entity catalog',
    description:
      'Creates a vehicle in this entity catalog. Requires owner role.',
  })
  @ApiCreatedResponse({ type: VehicleDto })
  @ApiBadRequestResponse({ type: ValidationProblemDetailsDto })
  @ApiNotFoundResponse({
    description: 'VEHICLE_TYPE_NOT_FOUND',
    type: ProblemDetailsDto,
  })
  @ApiConflictResponse({
    description: 'VEHICLE_DUPLICATE',
    type: ProblemDetailsDto,
  })
  create(@Body() dto: CreateVehicleDto): Promise<VehicleDto> {
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
    description: 'Updates brand, model and/or type. Requires owner role.',
  })
  @ApiOkResponse({ type: VehicleDto })
  @ApiBadRequestResponse({ type: ValidationProblemDetailsDto })
  @ApiNotFoundResponse({
    description: 'VEHICLE_NOT_FOUND | VEHICLE_TYPE_NOT_FOUND',
    type: ProblemDetailsDto,
  })
  @ApiConflictResponse({
    description: 'CONFLICT | VEHICLE_DUPLICATE',
    type: ProblemDetailsDto,
  })
  update(
    @Param('vehicleId', ParseUUIDPipe) vehicleId: string,
    @Query() query: ExpectedVersionQueryDto,
    @Body() dto: UpdateVehicleDto,
  ): Promise<VehicleDto> {
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
      'through GET /vehicles/changes as a tombstone so offline clients can ' +
      'remove it locally. Requires owner role.',
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
