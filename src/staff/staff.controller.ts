import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
} from '../utils/exceptions/dto/problem-details.dto';
import { ListStaffQueryDto } from './dto/list-staff-query.dto';
import { PaginatedStaffDto } from './dto/paginated-staff.dto';
import { StaffService } from './staff.service';

/**
 * Staff directory for the authenticated owner.
 *
 * Caller-scoped rather than lot-scoped, so there is no `:tenantId` and
 * therefore no `TenantMembershipGuard`. The scope is derived from the caller's
 * own `owner` memberships inside `StaffService`.
 */
@ApiTags('Staff')
@Controller('me/staff')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({
  description: 'Missing, malformed, or expired bearer token.',
  type: ProblemDetailsDto,
})
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Get()
  @ApiOperation({
    operationId: 'staffList',
    summary: 'People working at the lots the caller owns',
    description: [
      'One row per person, listing every role they hold across the caller’s lots — so someone working at two branches appears once with both roles rather than twice.',
      '',
      'Scope is the caller’s own `owner` memberships; admins see every lot. A caller who owns no lots gets an empty page, not an error.',
      '',
      'Supports search by name or email, filtering by role, narrowing to one lot, and pagination over people.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: PaginatedStaffDto })
  @ApiForbiddenResponse({
    description:
      '`tenantId` names a lot the caller does not own (`ENTITY_NO_ACCESS`).',
    type: ProblemDetailsDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid query parameters (validation failed).',
    type: ValidationProblemDetailsDto,
  })
  async list(
    @CurrentUser() user: User,
    @Query() query: ListStaffQueryDto,
  ): Promise<PaginatedStaffDto> {
    return this.staffService.listStaff(user, query);
  }
}
