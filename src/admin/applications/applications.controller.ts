import {
  Body,
  Controller,
  Get,
  Param,
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
  ApiQuery,
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
import { ApplicationsService } from './applications.service';
import { ApplicationDetailDto, ApplicationDto } from './dto/application.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
import { RejectApplicationDto } from './dto/reject-application.dto';

@ApiTags('Admin · Applications')
@ApiExtraModels(
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
  ApplicationDto,
  ApplicationDetailDto,
)
@Controller('admin/applications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('bearer')
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminApplicationsList',
    summary: 'List parking-lot onboarding applications (Ops review queue)',
    description: [
      'Returns the PARKIT Ops review queue: parking-lot onboarding applications submitted by owners, newest first.',
      '',
      'Each row is a denormalized summary (legal name, owner email, CUIT, declared-branch count, uploaded-document count, status and timestamps) — enough to triage without opening the detail.',
      '',
      '**Status mapping.** The optional `status` query uses the external contract `pending | approved | rejected`. The internal `pending_review` state surfaces as `pending`. Applications still in `draft` (never submitted) are never part of the queue.',
      '',
      '**No filter** returns every submitted application (`pending_review`, `approved`, `rejected`) and still excludes drafts.',
    ].join('\n'),
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['pending', 'approved', 'rejected'],
    description:
      'Filter by external status. Omit to return all submitted applications (drafts are always excluded). `pending` maps to the internal `pending_review` state.',
  })
  @ApiOkResponse({ type: ApplicationDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'Invalid `status` query value.',
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
  list(@Query() query: ListApplicationsQueryDto): Promise<ApplicationDto[]> {
    return this.applications.list(query);
  }

  @Get(':id')
  @ApiOperation({
    operationId: 'adminApplicationsGet',
    summary: 'Get a single onboarding application with full review detail',
    description: [
      'Returns the full detail an Ops reviewer needs to make a decision: the summary fields plus the declared entity data (name, address, legal data and per-vehicle spot counts), the uploaded documents and, when already reviewed, the rejection reason and review timestamp.',
      '',
      'This is the screen the reviewer opens before approving or rejecting an application.',
    ].join('\n'),
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Onboarding application id (uuid).',
  })
  @ApiOkResponse({ type: ApplicationDetailDto })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description: 'Authenticated caller does not hold the `admin` role.',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description: 'No onboarding application exists for the given id.',
    type: ProblemDetailsDto,
  })
  detail(@Param('id') id: string): Promise<ApplicationDetailDto> {
    return this.applications.getDetail(id);
  }

  @Post(':id/approve')
  @ApiOperation({
    operationId: 'adminApplicationsApprove',
    summary: 'Approve an onboarding application and provision the entity',
    description: [
      'Approves a submitted application and atomically provisions the entity (tenant). In a single transaction it:',
      '',
      '- materializes the declared entity as a real parking lot (tenant), with an initial `General` zone carrying the declared car/motorcycle/bicycle spot counts;',
      '- grants the applicant an `owner` membership on the created entity;',
      '- creates the system payment methods (`mp_transfer` as default, `cash`), which are non-deletable but can be disabled;',
      '- marks the application `approved` (linking the created `tenantId`) and records the audit trail.',
      '',
      'The entity-level role (`owner`) lives on the membership; the applicant global role stays `user`, so no JWT claim is changed.',
      '',
      '**Only `pending_review` applications can be approved.** Returns the updated application summary.',
    ].join('\n'),
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Onboarding application id (uuid).',
  })
  @ApiCreatedResponse({ type: ApplicationDto })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description: 'Authenticated caller does not hold the `admin` role.',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description: 'No onboarding application exists for the given id.',
    type: ProblemDetailsDto,
  })
  @ApiConflictResponse({
    description:
      'Application is not in `pending_review` (already approved/rejected or still a draft) and cannot be reviewed (`ONBOARDING_INVALID_STATE`).',
    type: ProblemDetailsDto,
  })
  approve(
    @CurrentUser() admin: User,
    @Param('id') id: string,
  ): Promise<ApplicationDto> {
    return this.applications.approve(admin, id);
  }

  @Post(':id/reject')
  @ApiOperation({
    operationId: 'adminApplicationsReject',
    summary: 'Reject an onboarding application with a reason',
    description: [
      'Marks a submitted application as `rejected`, storing the reviewer-provided `reason` (kept in the application history) and recording the audit trail.',
      '',
      'Rejection is not terminal: the owner can fix the issues called out in the reason and resubmit.',
      '',
      '**Only `pending_review` applications can be rejected.** Returns the updated application summary.',
    ].join('\n'),
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Onboarding application id (uuid).',
  })
  @ApiCreatedResponse({ type: ApplicationDto })
  @ApiBadRequestResponse({
    description: 'Invalid payload (missing or empty `reason`).',
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
    description: 'No onboarding application exists for the given id.',
    type: ProblemDetailsDto,
  })
  @ApiConflictResponse({
    description:
      'Application is not in `pending_review` (already approved/rejected or still a draft) and cannot be reviewed (`ONBOARDING_INVALID_STATE`).',
    type: ProblemDetailsDto,
  })
  reject(
    @CurrentUser() admin: User,
    @Param('id') id: string,
    @Body() dto: RejectApplicationDto,
  ): Promise<ApplicationDto> {
    return this.applications.reject(admin, id, dto);
  }
}
