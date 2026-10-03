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
import { CreateVehicleTypeDto } from './dto/create-vehicle-type.dto';
import {
  DeleteVehicleTypeQueryDto,
  DeleteVehicleTypeResultDto,
} from './dto/delete-vehicle-type.dto';
import { UpdateVehicleTypeDto } from './dto/update-vehicle-type.dto';
import {
  VehicleTypeChangesQueryDto,
  VehicleTypeChangesResponseDto,
} from './dto/vehicle-type-changes.dto';
import { VehicleTypeDto, VehicleTypeListItemDto } from './dto/vehicle-type.dto';
import { ExpectedVersionQueryDto } from '../vehicles/dto/expected-version-query.dto';
import { VehicleTypesService } from './vehicle-types.service';

@ApiTags('Vehicle types')
@ApiBearerAuth()
@Controller('tenants/:tenantId/vehicle-types')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
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
export class VehicleTypesController {
  constructor(private readonly vehicleTypes: VehicleTypesService) {}

  /**
   * Sin `@EntityRole`: mismo criterio que el catálogo de vehículos. El desktop
   * necesita los tipos para operar (la columna Tipo y el selector del ABM), y
   * cualquier miembro tiene que poder leerlos. Las mutaciones sí son owner-only.
   */
  @Get()
  @ApiOperation({
    operationId: 'vehicleTypesList',
    summary: 'List the entity vehicle types',
    description:
      'Tipos vivos del estacionamiento, ordenados por nombre, con el conteo ' +
      'de vehículos que usa cada uno. Disponible para cualquier miembro.',
  })
  @ApiOkResponse({ type: [VehicleTypeListItemDto] })
  list(): Promise<VehicleTypeListItemDto[]> {
    return this.vehicleTypes.listVehicleTypes();
  }

  /**
   * `'changes'` es un literal y no hay ningún `@Get(':typeId')`, así que no hay
   * ambigüedad de ruteo. Si algún día se agrega, este handler tiene que ir
   * declarado PRIMERO.
   */
  @Get('changes')
  @ApiOperation({
    operationId: 'vehicleTypesPullChanges',
    summary: 'Pull incremental vehicle type changes for offline sync',
    description:
      'Returns the entity vehicle types with syncSeq > afterSeq, INCLUDING ' +
      'soft-deleted rows (non-null deletedAt) so offline clients can drop them.',
  })
  @ApiOkResponse({ type: VehicleTypeChangesResponseDto })
  pullChanges(
    @Query() query: VehicleTypeChangesQueryDto,
  ): Promise<VehicleTypeChangesResponseDto> {
    return this.vehicleTypes.pullChanges(query);
  }

  @Post()
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    operationId: 'vehicleTypesCreate',
    summary: 'Create a vehicle type for the entity',
    description:
      'Requires owner role. El `id` lo genera el cliente (UUIDv7). `category` ' +
      'es opcional sólo por compatibilidad con cajas viejas: si falta se infiere ' +
      'y el tipo queda con `categoryInferred = true`.',
  })
  @ApiCreatedResponse({ type: VehicleTypeDto })
  @ApiBadRequestResponse({ type: ValidationProblemDetailsDto })
  @ApiConflictResponse({
    description: 'VEHICLE_TYPE_DUPLICATE',
    type: ProblemDetailsDto,
  })
  create(@Body() dto: CreateVehicleTypeDto): Promise<VehicleTypeDto> {
    return this.vehicleTypes.createVehicleType(dto);
  }

  @Patch(':typeId')
  @EntityRole(MembershipRole.owner)
  @ApiParam({ name: 'typeId', format: 'uuid' })
  @ApiOperation({
    operationId: 'vehicleTypesUpdate',
    summary: 'Update a vehicle type using optimistic locking (expectedVersion)',
    description:
      'Updates name, accepted and/or category. Guardar `category` apaga ' +
      '`categoryInferred`. Requires owner role.',
  })
  @ApiOkResponse({ type: VehicleTypeDto })
  @ApiBadRequestResponse({ type: ValidationProblemDetailsDto })
  @ApiNotFoundResponse({
    description: 'VEHICLE_TYPE_NOT_FOUND',
    type: ProblemDetailsDto,
  })
  @ApiConflictResponse({
    description: 'CONFLICT | VEHICLE_TYPE_DUPLICATE',
    type: ProblemDetailsDto,
  })
  update(
    @Param('typeId', ParseUUIDPipe) typeId: string,
    @Query() query: ExpectedVersionQueryDto,
    @Body() dto: UpdateVehicleTypeDto,
  ): Promise<VehicleTypeDto> {
    return this.vehicleTypes.updateVehicleType(
      typeId,
      query.expectedVersion,
      dto,
    );
  }

  /**
   * Devuelve 200 con body y no 204: el cliente necesita saber CUÁNTOS vehículos
   * cambiaron de `syncSeq` para decidir si re-pullea el catálogo.
   */
  @Delete(':typeId')
  @EntityRole(MembershipRole.owner)
  @ApiParam({ name: 'typeId', format: 'uuid' })
  @ApiOperation({
    operationId: 'vehicleTypesDelete',
    summary: 'Soft-delete a vehicle type, reassigning its vehicles',
    description:
      'Borrado lógico: la fila sigue viajando por /vehicle-types/changes como ' +
      'tombstone. Si quedan vehículos usándolo hay que mandar ' +
      '`reassignToTypeId`; si no, responde 409 VEHICLE_TYPE_IN_USE. Requiere ' +
      'rol owner.',
  })
  @ApiOkResponse({ type: DeleteVehicleTypeResultDto })
  @ApiBadRequestResponse({
    description: 'VEHICLE_TYPE_REASSIGN_TARGET_INVALID',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description: 'VEHICLE_TYPE_NOT_FOUND',
    type: ProblemDetailsDto,
  })
  @ApiConflictResponse({
    description: 'VEHICLE_TYPE_IN_USE | CONFLICT (stale version or deleted)',
    type: ProblemDetailsDto,
  })
  remove(
    @Param('typeId', ParseUUIDPipe) typeId: string,
    @Query() query: DeleteVehicleTypeQueryDto,
  ): Promise<DeleteVehicleTypeResultDto> {
    return this.vehicleTypes.deleteVehicleType(
      typeId,
      query.expectedVersion,
      query.reassignToTypeId,
    );
  }
}
