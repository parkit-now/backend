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
import type { User } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import {
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
} from '../../utils/exceptions/dto/problem-details.dto';
import { AdminUsersService } from './admin-users.service';
import {
  AdminUserDetailDto,
  AdminUserMembershipDto,
} from './dto/admin-user-detail.dto';
import { AdminUserDto } from './dto/admin-user.dto';
import { CreateMembershipDto } from './dto/create-membership.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { PaginatedUsersDto } from './dto/paginated-users.dto';
import { UpdateAdminUserDto } from './dto/update-admin-user.dto';
import { UpdateMembershipDto } from './dto/update-membership.dto';

@ApiTags('Admin · Users')
@ApiExtraModels(
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
  AdminUserDto,
  AdminUserDetailDto,
  AdminUserMembershipDto,
  PaginatedUsersDto,
)
@Controller('admin/users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('bearer')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminUsersList',
    summary: 'List platform users (paginated, searchable)',
    description:
      'Returns a page of users ordered by name. Supports a case-insensitive `search` matched against the user name and email.',
  })
  @ApiOkResponse({ type: PaginatedUsersDto })
  @ApiBadRequestResponse({
    description: 'Invalid pagination/search query.',
    type: ValidationProblemDetailsDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description: 'Authenticated caller does not hold the `admin` role.',
    type: ProblemDetailsDto,
  })
  list(@Query() query: ListUsersQueryDto): Promise<PaginatedUsersDto> {
    return this.users.list(query);
  }

  @Get(':id')
  @ApiOperation({
    operationId: 'adminUsersGet',
    summary: 'Get a user with their parking memberships',
    description:
      'Returns the user identity plus the list of parking lots they are linked to and the role held at each one.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'User id (uuid).' })
  @ApiOkResponse({ type: AdminUserDetailDto })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description: 'Authenticated caller does not hold the `admin` role.',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description: 'No user exists for the given id (`USER_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  detail(@Param('id') id: string): Promise<AdminUserDetailDto> {
    return this.users.getDetail(id);
  }

  @Patch(':id')
  @ApiOperation({
    operationId: 'adminUsersUpdateRole',
    summary: "Change a user's global role",
    description:
      'Updates the GLOBAL platform role (`admin | user`). Per-parking roles are managed via the membership endpoints; email/name are owned by Supabase Auth.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'User id (uuid).' })
  @ApiOkResponse({ type: AdminUserDto })
  @ApiBadRequestResponse({
    description: 'Invalid payload (e.g. unknown role).',
    type: ValidationProblemDetailsDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description: 'Authenticated caller does not hold the `admin` role.',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description: 'No user exists for the given id (`USER_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  updateRole(
    @CurrentUser() admin: User,
    @Param('id') id: string,
    @Body() dto: UpdateAdminUserDto,
  ): Promise<AdminUserDto> {
    return this.users.updateRole(admin, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'adminUsersDelete',
    summary: 'Delete a user completely',
    description:
      'Permanently deletes the user from Supabase Auth; the platform record and parking memberships are removed by cascade. The account can no longer authenticate.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'User id (uuid).' })
  @ApiNoContentResponse({ description: 'User deleted.' })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description: 'Authenticated caller does not hold the `admin` role.',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description: 'No user exists for the given id (`USER_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  remove(@CurrentUser() admin: User, @Param('id') id: string): Promise<void> {
    return this.users.remove(admin, id);
  }

  @Post(':id/memberships')
  @ApiOperation({
    operationId: 'adminUsersAddMembership',
    summary: 'Link a user to a parking lot with a role',
    description:
      'Grants the user a membership at a parking lot with the given role (`owner` or `operator`).',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'User id (uuid).' })
  @ApiCreatedResponse({ type: AdminUserMembershipDto })
  @ApiBadRequestResponse({
    description: 'Invalid payload.',
    type: ValidationProblemDetailsDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description: 'Authenticated caller does not hold the `admin` role.',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description:
      'The user (`USER_NOT_FOUND`) or the parking lot (`PARKING_NOT_FOUND`) does not exist.',
    type: ProblemDetailsDto,
  })
  @ApiConflictResponse({
    description:
      'The user already has a membership at this parking lot (`MEMBERSHIP_ALREADY_EXISTS`).',
    type: ProblemDetailsDto,
  })
  addMembership(
    @CurrentUser() admin: User,
    @Param('id') id: string,
    @Body() dto: CreateMembershipDto,
  ): Promise<AdminUserMembershipDto> {
    return this.users.addMembership(admin, id, dto);
  }

  @Patch(':id/memberships/:parkingId')
  @ApiOperation({
    operationId: 'adminUsersUpdateMembership',
    summary: "Change a user's role at a parking lot",
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'User id (uuid).' })
  @ApiParam({
    name: 'parkingId',
    format: 'uuid',
    description: 'Parking lot id (uuid).',
  })
  @ApiOkResponse({ type: AdminUserMembershipDto })
  @ApiBadRequestResponse({
    description: 'Invalid payload.',
    type: ValidationProblemDetailsDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description: 'Authenticated caller does not hold the `admin` role.',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description:
      'The user has no membership at the given parking lot (`MEMBERSHIP_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  updateMembership(
    @CurrentUser() admin: User,
    @Param('id') id: string,
    @Param('parkingId') parkingId: string,
    @Body() dto: UpdateMembershipDto,
  ): Promise<AdminUserMembershipDto> {
    return this.users.updateMembership(admin, id, parkingId, dto);
  }

  @Delete(':id/memberships/:parkingId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'adminUsersRemoveMembership',
    summary: 'Unlink a user from a parking lot',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'User id (uuid).' })
  @ApiParam({
    name: 'parkingId',
    format: 'uuid',
    description: 'Parking lot id (uuid).',
  })
  @ApiNoContentResponse({ description: 'Membership removed.' })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description: 'Authenticated caller does not hold the `admin` role.',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description:
      'The user has no membership at the given parking lot (`MEMBERSHIP_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  removeMembership(
    @CurrentUser() admin: User,
    @Param('id') id: string,
    @Param('parkingId') parkingId: string,
  ): Promise<void> {
    return this.users.removeMembership(admin, id, parkingId);
  }
}
