import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { EntityRole } from '../auth/decorators/entity-role.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import {
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
} from '../utils/exceptions/dto/problem-details.dto';
import { CreateStaffMemberDto } from './dto/create-staff-member.dto';
import { StaffMembershipResultDto } from './dto/staff-membership-result.dto';
import { UpdateStaffMemberDto } from './dto/update-staff-member.dto';
import { TenantStaffService } from './tenant-staff.service';

/**
 * ABM del personal de un estacionamiento, para su dueño.
 *
 * Lot-scoped, al revés que el `GET /me/staff` de `StaffController`: acá el lote
 * está en la URL, así que `TenantMembershipGuard` + `@EntityRole(owner)` hacen
 * la autorización y el service no tiene que re-implementarla. Lo único que
 * queda de su lado es lo que el guard no puede ver: el lote destino de una
 * mudanza, el self-guard y el last-owner-guard.
 */
@ApiTags('Staff')
@ApiBearerAuth('bearer')
@Controller('tenants/:tenantId/staff')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiParam({
  name: 'tenantId',
  format: 'uuid',
  description: 'ID de la entidad (estacionamiento / tenant).',
})
@ApiUnauthorizedResponse({
  description: 'Missing, malformed, or expired bearer token.',
  type: ProblemDetailsDto,
})
@ApiForbiddenResponse({
  description:
    'Caller is not a member of the entity (`ENTITY_NO_ACCESS`), or is a member without the `owner` role (`ENTITY_INSUFFICIENT_ROLE`).',
  type: ProblemDetailsDto,
})
export class TenantStaffController {
  constructor(private readonly staff: TenantStaffService) {}

  @Post()
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    operationId: 'tenantStaffAdd',
    summary: 'Add a person to this lot’s staff',
    description: [
      'Requires owner role. La persona se identifica por email y tiene que tener cuenta: **no hay invitación**, si el mail no está registrado la respuesta es `404 USER_NOT_FOUND`.',
      '',
      'Es también la forma de darle a alguien un rol en un lote **adicional** sin sacarle el que ya tiene: mismo email, otro `:tenantId`.',
    ].join('\n'),
  })
  @ApiCreatedResponse({ type: StaffMembershipResultDto })
  @ApiBadRequestResponse({ type: ValidationProblemDetailsDto })
  @ApiNotFoundResponse({
    description: 'No account registered with that email (`USER_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  @ApiConflictResponse({
    description:
      'The person already works at this lot (`MEMBERSHIP_ALREADY_EXISTS`).',
    type: ProblemDetailsDto,
  })
  add(
    @CurrentUser() caller: User,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: CreateStaffMemberDto,
  ): Promise<StaffMembershipResultDto> {
    return this.staff.addStaff(caller, tenantId, dto);
  }

  @Patch(':userId')
  @EntityRole(MembershipRole.owner)
  @ApiParam({
    name: 'userId',
    format: 'uuid',
    description:
      'Id de la persona (no el de la membresía: no tiene id propio).',
  })
  @ApiOperation({
    operationId: 'tenantStaffUpdate',
    summary: 'Change a person’s role, or move them to another lot',
    description: [
      'Requires owner role. Acepta `role`, `tenantId` o los dos; un body vacío es `400`.',
      '',
      '`tenantId` **muda** la membresía: el lote de la URL la pierde y el caller tiene que ser owner de ambos. Para que la persona trabaje en los dos a la vez, usar `POST /tenants/<el otro>/staff` en vez de este endpoint.',
      '',
      'No se puede modificar la membresía propia, ni dejar al lote sin ningún owner.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: StaffMembershipResultDto })
  @ApiBadRequestResponse({ type: ValidationProblemDetailsDto })
  @ApiForbiddenResponse({
    description:
      'Own membership (`STAFF_SELF_MANAGEMENT`), or the destination lot is not the caller’s (`ENTITY_NO_ACCESS`).',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description: '`MEMBERSHIP_NOT_FOUND` | `ENTITY_NOT_FOUND` (destination).',
    type: ProblemDetailsDto,
  })
  @ApiConflictResponse({
    description:
      '`STAFF_LAST_OWNER` (would leave the lot ownerless) | `MEMBERSHIP_ALREADY_EXISTS` (already works at the destination).',
    type: ProblemDetailsDto,
  })
  update(
    @CurrentUser() caller: User,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateStaffMemberDto,
  ): Promise<StaffMembershipResultDto> {
    return this.staff.updateStaff(caller, tenantId, userId, dto);
  }

  @Delete(':userId')
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({
    name: 'userId',
    format: 'uuid',
    description: 'Id de la persona.',
  })
  @ApiOperation({
    operationId: 'tenantStaffRemove',
    summary: 'Remove a person from this lot’s staff',
    description: [
      'Requires owner role. Desvincula a la persona de **este** lote; su cuenta y sus otros lotes no se tocan.',
      '',
      'No se puede eliminar la membresía propia, ni la del último owner del lote.',
    ].join('\n'),
  })
  @ApiNoContentResponse({ description: 'Membership removed.' })
  @ApiForbiddenResponse({
    description: 'Own membership (`STAFF_SELF_MANAGEMENT`).',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description:
      'The person does not work at this lot (`MEMBERSHIP_NOT_FOUND`). A repeated DELETE lands here.',
    type: ProblemDetailsDto,
  })
  @ApiConflictResponse({
    description: 'Would leave the lot without an owner (`STAFF_LAST_OWNER`).',
    type: ProblemDetailsDto,
  })
  remove(
    @CurrentUser() caller: User,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    return this.staff.removeStaff(caller, tenantId, userId);
  }
}
