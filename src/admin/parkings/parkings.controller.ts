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
import { CreateParkingDto } from './dto/create-parking.dto';
import { ListParkingsQueryDto } from './dto/list-parkings-query.dto';
import { PaginatedParkingsDto } from './dto/paginated-parkings.dto';
import { ParkingDto } from './dto/parking.dto';
import { UpdateParkingDto } from './dto/update-parking.dto';
import { ParkingsService } from './parkings.service';

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
  constructor(private readonly parkings: ParkingsService) {}

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

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'adminParkingsDelete',
    summary: 'Delete a parking lot',
    description:
      'Permanently deletes the parking lot. Dependent data (memberships, rates, entries and payment methods) is removed by cascade.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Parking lot id (uuid).',
  })
  @ApiNoContentResponse({ description: 'Parking lot deleted.' })
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
  remove(@CurrentUser() admin: User, @Param('id') id: string): Promise<void> {
    return this.parkings.remove(admin, id);
  }
}
