import {
  Body,
  Controller,
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
import { CreateParkingDto } from './dto/create-parking.dto';
import { DeleteParkingDto } from './dto/delete-parking.dto';
import { DeletionPreflightDto } from './dto/deletion-preflight.dto';
import { DeletionResultDto } from './dto/deletion-result.dto';
import { ListParkingsQueryDto } from './dto/list-parkings-query.dto';
import { PaginatedParkingsDto } from './dto/paginated-parkings.dto';
import { ParkingDto } from './dto/parking.dto';
import { UpdateParkingDto } from './dto/update-parking.dto';
import { ParkingDeletionService } from './parking-deletion.service';
import { ParkingsService, toParkingDto } from './parkings.service';

@ApiTags('Admin · Parkings')
@ApiExtraModels(
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
  ParkingDto,
  PaginatedParkingsDto,
)
@Controller('admin/parkings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('bearer')
export class ParkingsController {
  constructor(
    private readonly parkings: ParkingsService,
    private readonly deletion: ParkingDeletionService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'adminParkingsList',
    summary: 'List parking lots (paginated, searchable)',
    description: [
      'Returns a page of parking lots ordered by name. Supports a case-insensitive `search` matched against the name and address.',
      '',
      'This single endpoint powers both the admin inventory table and the parking autocomplete used when linking a user to a lot (`POST /admin/users/:id/memberships`).',
    ].join('\n'),
  })
  @ApiOkResponse({ type: PaginatedParkingsDto })
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
  list(@Query() query: ListParkingsQueryDto): Promise<PaginatedParkingsDto> {
    return this.parkings.list(query);
  }

  @Get(':id')
  @ApiOperation({
    operationId: 'adminParkingsGet',
    summary: 'Get a single parking lot',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Parking lot id (uuid).',
  })
  @ApiOkResponse({ type: ParkingDto })
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
      'No parking lot exists for the given id (`PARKING_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  get(@Param('id') id: string): Promise<ParkingDto> {
    return this.parkings.get(id);
  }

  @Post()
  @ApiOperation({
    operationId: 'adminParkingsCreate',
    summary: 'Create a parking lot with basic data',
    description:
      'Creates a parking lot (tenant) with its basic data and no owner attached. Ownership/operator roles are granted afterwards via memberships.',
  })
  @ApiCreatedResponse({ type: ParkingDto })
  @ApiBadRequestResponse({
    description: 'Invalid payload (e.g. missing `name`).',
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
  create(
    @CurrentUser() admin: User,
    @Body() dto: CreateParkingDto,
  ): Promise<ParkingDto> {
    return this.parkings.create(admin, dto);
  }

  @Patch(':id')
  @ApiOperation({
    operationId: 'adminParkingsUpdate',
    summary: 'Edit a parking lot',
    description:
      'Updates the parking-lot basic data. Include `status` to move the lot in or out of `maintenance`.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Parking lot id (uuid).',
  })
  @ApiOkResponse({ type: ParkingDto })
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
      'No parking lot exists for the given id (`PARKING_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  update(
    @CurrentUser() admin: User,
    @Param('id') id: string,
    @Body() dto: UpdateParkingDto,
  ): Promise<ParkingDto> {
    return this.parkings.update(admin, id, dto);
  }

  @Get(':id/deletion-preflight')
  @ApiOperation({
    operationId: 'adminParkingsDeletionPreflight',
    summary: 'What deleting this parking lot would destroy',
    description:
      'Counts to show before confirming: staff, cars inside, entries, cash ' +
      'sessions, invoices, bucket objects and audit rows, plus whether ' +
      'Mercado Pago and ARCA are linked. `blockers` lists third-party money ' +
      'that would be stranded; it is informational and never prevents the ' +
      'deletion.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Parking lot id (uuid).',
  })
  @ApiOkResponse({ type: DeletionPreflightDto })
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
      'No parking lot exists for the given id (`PARKING_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  preflight(@Param('id') id: string): Promise<DeletionPreflightDto> {
    return this.deletion.preflight(id);
  }

  @Post(':id/deletion')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'adminParkingsDelete',
    summary: 'Soft-delete a parking lot',
    description:
      'Marks the parking lot as deleted. It disappears from every read but ' +
      "the admin's and keeps returning 410 `ENTITY_DELETED` to its members, " +
      'and `TenantPurgeService` erases it for good — database and bucket — ' +
      'once `graceDays` have passed. Reversible until then via `/restore`. ' +
      'Requires typing the exact parking name in `confirmName`.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Parking lot id (uuid).',
  })
  @ApiOkResponse({ type: DeletionResultDto })
  @ApiBadRequestResponse({
    description:
      'Payload failed validation, or the typed name does not match ' +
      '(`PARKING_CONFIRM_NAME_MISMATCH`).',
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
      'No parking lot exists for the given id (`PARKING_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  @ApiConflictResponse({
    description: 'Already deleted (`PARKING_ALREADY_DELETED`).',
    type: ProblemDetailsDto,
  })
  async delete(
    @CurrentUser() admin: User,
    @Param('id') id: string,
    @Body() dto: DeleteParkingDto,
  ): Promise<DeletionResultDto> {
    const { tenant, effects } = await this.deletion.delete(admin, id, dto);
    return { parking: toParkingDto(tenant), effects };
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'adminParkingsRestore',
    summary: 'Undo a soft-delete',
    description:
      'Brings a deleted parking lot back, with its data. Only possible ' +
      'before the purge. Mercado Pago and ARCA are NOT re-linked and ' +
      'cancelled reservations stay cancelled: those are re-done by hand.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Parking lot id (uuid).',
  })
  @ApiOkResponse({ type: ParkingDto })
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
      'No parking lot exists for the given id (`PARKING_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  @ApiConflictResponse({
    description: 'The parking lot is not deleted (`PARKING_NOT_DELETED`).',
    type: ProblemDetailsDto,
  })
  async restore(
    @CurrentUser() admin: User,
    @Param('id') id: string,
  ): Promise<ParkingDto> {
    return toParkingDto(await this.deletion.restore(admin, id));
  }
}
