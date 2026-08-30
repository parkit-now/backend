import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
  ApiExtraModels,
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
import type { User } from '@prisma/client';
import { AuditEventDto } from '../audit/dto/audit-event.dto';
import { PaginatedAuditDto } from '../audit/dto/paginated-audit.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { EntityRole } from '../auth/decorators/entity-role.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import {
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
} from '../utils/exceptions/dto/problem-details.dto';
import { EntitiesService } from './entities.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { EntityAuditQueryDto } from './dto/entity-audit-query.dto';
import {
  EntityCapacityDto,
  EntityProfileDto,
  PaymentMethodSummaryDto,
} from './dto/entity-profile.dto';
import { CreatePaymentMethodDto } from './dto/create-payment-method.dto';
import { PaymentMethodChangesQueryDto } from './dto/payment-method-changes-query.dto';
import { PaymentMethodChangesResponseDto } from './dto/payment-method-changes-response.dto';
import { TogglePaymentMethodDto } from './dto/toggle-payment-method.dto';
import { UpdateEntityProfileDto } from './dto/update-entity-profile.dto';
import { CreateVehicleDto } from '../vehicles/dto/create-vehicle.dto';
import { UpdateVehicleDto } from '../vehicles/dto/update-vehicle.dto';
import {
  VehicleCatalogChangesQueryDto,
  VehicleCatalogChangesResponseDto,
  VehicleCatalogItemDto,
} from '../vehicles/dto/vehicle-catalog.dto';

@ApiTags('Entities')
@ApiExtraModels(
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
  EntityProfileDto,
  EntityCapacityDto,
  PaymentMethodSummaryDto,
  PaymentMethodChangesResponseDto,
  AuditEventDto,
  PaginatedAuditDto,
)
// Entity-scoped: routes depend on the tenant (parking lot / entity).
@Controller('tenants/:tenantId')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('bearer')
@ApiParam({
  name: 'tenantId',
  format: 'uuid',
  description: 'ID of the entity (parking lot / tenant).',
})
@ApiUnauthorizedResponse({
  description: 'Missing, malformed, or expired bearer token.',
  type: ProblemDetailsDto,
})
@ApiForbiddenResponse({
  description:
    'The caller is authenticated but is not a member of the `:tenantId` entity.',
  type: ProblemDetailsDto,
})
export class EntitiesController {
  constructor(
    private readonly entities: EntitiesService,
    private readonly vehicles: VehiclesService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'entitiesGetProfile',
    summary: 'Get the entity profile',
    description: [
      'Returns the profile of the `:tenantId` entity (parking lot): its contact/legal data, operational status and a summary of its configured payment methods.',
      '',
      'Available to any member of the entity.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: EntityProfileDto })
  @ApiNotFoundResponse({
    description: 'No entity matches the given id (ENTITY_NOT_FOUND).',
    type: ProblemDetailsDto,
  })
  getProfile(@Param('tenantId') tenantId: string): Promise<EntityProfileDto> {
    return this.entities.getProfile(tenantId);
  }

  @Patch()
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    operationId: 'entitiesUpdateProfile',
    summary: 'Update the entity profile',
    description: [
      'Edits the editable fields of the entity profile (`name`, `legalName`, `cuit`, `email`, `phone`, `address`, `status`) and its per-vehicle-type spot `capacity`.',
      '',
      'Use `status: maintenance` to take the lot offline. `capacity` is merged: only the supplied vehicle types change. Every change is written to the audit trail. Requires the caller to be an `owner` of the entity (platform admins bypass the role check).',
    ].join('\n'),
  })
  @ApiOkResponse({ type: EntityProfileDto })
  @ApiBadRequestResponse({
    description: 'Invalid payload (validation failed).',
    type: ValidationProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description: 'No entity matches the given id (ENTITY_NOT_FOUND).',
    type: ProblemDetailsDto,
  })
  updateProfile(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: User,
    @Body() dto: UpdateEntityProfileDto,
  ): Promise<EntityProfileDto> {
    return this.entities.updateProfile(tenantId, user, dto);
  }

  // ── Vehicle catalog ────────────────────────────────────────────────────────

  @Get('vehicles/catalog')
  @ApiOperation({
    operationId: 'entitiesPullVehicleCatalog',
    summary: 'Pull vehicle catalog changes',
    description:
      'Returns global vehicles (admin-managed) and tenant-specific vehicles with syncSeq > afterSeq. Used by the desktop for offline-first autocomplete.',
  })
  @ApiOkResponse({ type: VehicleCatalogChangesResponseDto })
  pullVehicleCatalog(
    @Param('tenantId') tenantId: string,
    @Query() query: VehicleCatalogChangesQueryDto,
  ): Promise<VehicleCatalogChangesResponseDto> {
    return this.vehicles.pullCatalogChanges(tenantId, query);
  }

  @Post('vehicles')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    operationId: 'entitiesCreateTenantVehicle',
    summary: 'Add a vehicle to the tenant catalog',
    description:
      'Creates a tenant-specific vehicle entry in the catalog. Requires owner role.',
  })
  @ApiCreatedResponse({ type: VehicleCatalogItemDto })
  @ApiBadRequestResponse({ type: ValidationProblemDetailsDto })
  createTenantVehicle(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateVehicleDto,
  ): Promise<VehicleCatalogItemDto> {
    return this.vehicles.createTenantVehicle(tenantId, dto);
  }

  @Patch('vehicles/:vehicleId')
  @EntityRole(MembershipRole.owner)
  @ApiParam({
    name: 'vehicleId',
    format: 'uuid',
    description: 'ID of the tenant vehicle to update.',
  })
  @ApiOperation({
    operationId: 'entitiesUpdateTenantVehicle',
    summary: 'Update a tenant vehicle',
    description:
      'Updates brand, model, and/or type of a tenant-specific vehicle. Global vehicles cannot be edited. Requires owner role.',
  })
  @ApiOkResponse({ type: VehicleCatalogItemDto })
  @ApiBadRequestResponse({ type: ValidationProblemDetailsDto })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  updateTenantVehicle(
    @Param('tenantId') tenantId: string,
    @Param('vehicleId') vehicleId: string,
    @Body() dto: UpdateVehicleDto,
  ): Promise<VehicleCatalogItemDto> {
    return this.vehicles.updateTenantVehicle(vehicleId, tenantId, dto);
  }

  @Delete('vehicles/:vehicleId')
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({
    name: 'vehicleId',
    format: 'uuid',
    description: 'ID of the tenant vehicle to delete.',
  })
  @ApiOperation({
    operationId: 'entitiesDeleteTenantVehicle',
    summary: 'Soft-delete a tenant vehicle',
    description:
      'Soft-deletes a tenant-specific vehicle (sets deleted_at). Global vehicles cannot be deleted. Requires owner role.',
  })
  @ApiNoContentResponse({ description: 'Vehicle deleted.' })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  deleteTenantVehicle(
    @Param('tenantId') tenantId: string,
    @Param('vehicleId') vehicleId: string,
  ): Promise<void> {
    return this.vehicles.deleteTenantVehicle(vehicleId, tenantId);
  }

  // ── Payment methods ─────────────────────────────────────────────────────────

  @Get('payment-methods/changes')
  @ApiOperation({
    operationId: 'entitiesPullPaymentMethodChanges',
    summary: 'Pull incremental payment method changes',
    description:
      'Returns payment methods with syncSeq > afterSeq, ordered by syncSeq. Used by the desktop for offline-first sync.',
  })
  @ApiOkResponse({ type: PaymentMethodChangesResponseDto })
  pullPaymentMethodChanges(
    @Param('tenantId') tenantId: string,
    @Query() query: PaymentMethodChangesQueryDto,
  ): Promise<PaymentMethodChangesResponseDto> {
    return this.entities.pullPaymentMethodChanges(tenantId, query);
  }

  @Get('payment-methods')
  @ApiOperation({
    operationId: 'entitiesListPaymentMethods',
    summary: 'List the entity payment methods',
    description: [
      'Returns every payment method configured for the `:tenantId` entity, oldest first.',
      '',
      'System methods (`transfer`, `cash`) are flagged with `isSystem: true` — they can be enabled or disabled but never deleted. Available to any member of the entity.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: PaymentMethodSummaryDto, isArray: true })
  listPaymentMethods(
    @Param('tenantId') tenantId: string,
  ): Promise<PaymentMethodSummaryDto[]> {
    return this.entities.listPaymentMethods(tenantId);
  }

  @Post('payment-methods')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    operationId: 'entitiesCreatePaymentMethod',
    summary: 'Create a custom payment method',
    description:
      'Creates a new non-system payment method for the entity. Requires owner role.',
  })
  @ApiCreatedResponse({ type: PaymentMethodSummaryDto })
  @ApiBadRequestResponse({ type: ValidationProblemDetailsDto })
  createPaymentMethod(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: User,
    @Body() dto: CreatePaymentMethodDto,
  ): Promise<PaymentMethodSummaryDto> {
    return this.entities.createPaymentMethod(tenantId, user, dto);
  }

  @Patch('payment-methods/:id')
  @EntityRole(MembershipRole.owner)
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'ID of the payment method to toggle.',
  })
  @ApiOperation({
    operationId: 'entitiesTogglePaymentMethod',
    summary: 'Enable/disable or set-default a payment method',
    description: [
      'Toggles a payment method via the `enabled` and/or `isDefault` flags.',
      '',
      'System methods (`transfer`, `cash`) can be disabled but never deleted. Setting `isDefault: true` clears the previous default. The change is recorded in the audit trail. Requires the caller to be an `owner` of the entity (platform admins bypass the role check).',
    ].join('\n'),
  })
  @ApiOkResponse({ type: PaymentMethodSummaryDto })
  @ApiBadRequestResponse({
    description: 'Invalid payload (validation failed).',
    type: ValidationProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description:
      'No payment method matches the given id in this entity (PAYMENT_METHOD_NOT_FOUND).',
    type: ProblemDetailsDto,
  })
  togglePaymentMethod(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: TogglePaymentMethodDto,
  ): Promise<PaymentMethodSummaryDto> {
    return this.entities.togglePaymentMethod(tenantId, user, id, dto);
  }

  @Delete('payment-methods/:id')
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'ID of the payment method to delete.',
  })
  @ApiOperation({
    operationId: 'entitiesDeletePaymentMethod',
    summary: 'Delete a custom payment method',
    description:
      'Permanently deletes a non-system payment method. System methods (`cash`, `transfer`) cannot be deleted — disable them instead. Requires owner role.',
  })
  @ApiNoContentResponse({ description: 'Payment method deleted.' })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  @ApiConflictResponse({
    description: 'Attempted to delete a system method.',
    type: ProblemDetailsDto,
  })
  deletePaymentMethod(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<void> {
    return this.entities.deletePaymentMethod(tenantId, user, id);
  }

  @Get('audit')
  @ApiOperation({
    operationId: 'entitiesListAudit',
    summary: 'Read the entity audit trail',
    description: [
      'Returns a page of audit events recorded for the `:tenantId` entity, most recent first. Available to any member of the entity.',
      '',
      'Filters by `severity`, a single `action` from the catalog, and a `from`/`to` instant range (half-open, ISO-8601 with an explicit offset). They compose.',
      '',
      '**What this covers:** configuration and lifecycle changes — profile edits, payment-method toggles, onboarding, LPR event review, admin actions.',
      '',
      '**What it does not:** payments and vehicle entries/exits are not written to the audit trail, and there is no maximum-stay concept, so no overstay alerts. For operational figures use `/metrics/*`; for detections pending review use `/lpr-events?status=pending`.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: PaginatedAuditDto })
  @ApiBadRequestResponse({
    description:
      'Invalid query parameters, an unknown `action`, a date-time without an explicit offset, or `from` not earlier than `to`.',
    type: ValidationProblemDetailsDto,
  })
  listAudit(
    @Param('tenantId') tenantId: string,
    @Query() query: EntityAuditQueryDto,
  ): Promise<PaginatedAuditDto> {
    return this.entities.listAudit(tenantId, query);
  }
}
