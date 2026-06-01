import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
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
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
} from '../utils/exceptions/dto/problem-details.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import {
  ApplicationDocumentDto,
  OnboardingApplicationDto,
} from './dto/onboarding-response.dto';
import { RegisterDocumentDto } from './dto/register-document.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { OnboardingService } from './onboarding.service';

@ApiTags('Onboarding')
@ApiExtraModels(
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
  OnboardingApplicationDto,
  ApplicationDocumentDto,
)
@Controller('onboarding/applications')
@UseGuards(JwtAuthGuard, RolesGuard)
// Any authenticated user can apply to register a parking lot. A `driver`
// applicant is promoted to `owner` when the application is approved (admin).
@Roles('owner', 'driver', 'operator', 'admin')
@ApiBearerAuth('bearer')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    operationId: 'onboardingCreateApplication',
    summary: 'Create a draft onboarding application',
    description: [
      'Creates a draft `OnboardingApplication` for the authenticated user declaring ONE entity (parking lot): `name`, `address`, `legalName`, `cuit`, `email`, `phone` and optional spot counts.',
      '',
      'The application starts in `draft`. Subsequent steps attach documents and submit it for PARKIT Ops review.',
    ].join('\n'),
  })
  @ApiCreatedResponse({ type: OnboardingApplicationDto })
  @ApiBadRequestResponse({
    description:
      'Invalid payload (validation: missing fields, malformed CUIT/email, etc.).',
    type: ValidationProblemDetailsDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  create(
    @CurrentUser() user: User,
    @Body() dto: CreateApplicationDto,
  ): Promise<OnboardingApplicationDto> {
    return this.onboarding.create(user, dto);
  }

  @Get()
  @ApiOperation({
    operationId: 'onboardingListApplications',
    summary: 'List the applications of the authenticated user',
    description:
      'Returns every onboarding application created by the caller, newest first.',
  })
  @ApiOkResponse({ type: OnboardingApplicationDto, isArray: true })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  list(@CurrentUser() user: User): Promise<OnboardingApplicationDto[]> {
    return this.onboarding.list(user);
  }

  @Get(':id')
  @ApiParam({
    name: 'id',
    description: 'The onboarding application id (UUID).',
    format: 'uuid',
  })
  @ApiOperation({
    operationId: 'onboardingGetApplication',
    summary: 'Get one of the applications of the authenticated user',
    description: 'Returns a single onboarding application owned by the caller.',
  })
  @ApiOkResponse({ type: OnboardingApplicationDto })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description: 'The caller is not the applicant (`ENTITY_NOT_OWNER`).',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description:
      'No application exists for the given id (`ONBOARDING_APPLICATION_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  getOne(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<OnboardingApplicationDto> {
    return this.onboarding.getOne(user, id);
  }

  @Patch(':id')
  @ApiParam({
    name: 'id',
    description: 'The onboarding application id (UUID).',
    format: 'uuid',
  })
  @ApiOperation({
    operationId: 'onboardingUpdateApplication',
    summary: 'Edit the declared entity of a draft or rejected application',
    description: [
      'Patches the declared-entity data of an application that is still editable.',
      '',
      '**Editable states only:** `draft` and `rejected`. An application in `pending_review` or `approved` can no longer be edited. Editing a rejected application is how an applicant fixes the issues raised by PARKIT Ops before resubmitting.',
      '',
      'All fields are optional (partial update); the provided fields are merged into the declared entity.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: OnboardingApplicationDto })
  @ApiBadRequestResponse({
    description: 'Invalid payload (validation failed).',
    type: ValidationProblemDetailsDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description: 'The caller is not the applicant (`ENTITY_NOT_OWNER`).',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description:
      'No application exists for the given id (`ONBOARDING_APPLICATION_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  @ApiConflictResponse({
    description:
      'The application is not in an editable state (`ONBOARDING_INVALID_STATE`).',
    type: ProblemDetailsDto,
  })
  update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateApplicationDto,
  ): Promise<OnboardingApplicationDto> {
    return this.onboarding.update(user, id, dto);
  }

  @Post(':id/documents')
  @HttpCode(HttpStatus.CREATED)
  @ApiParam({
    name: 'id',
    description: 'The onboarding application id (UUID).',
    format: 'uuid',
  })
  @ApiOperation({
    operationId: 'onboardingAddDocument',
    summary: 'Register document metadata for an application',
    description: [
      'Registers the metadata of a supporting document attached to the application.',
      '',
      '**The binary is uploaded out-of-band.** The client uploads the file directly to Supabase Storage; this endpoint only persists its metadata (`name`, `storagePath`, optional `mimeType`).',
    ].join('\n'),
  })
  @ApiCreatedResponse({ type: ApplicationDocumentDto })
  @ApiBadRequestResponse({
    description: 'Invalid payload (validation: missing `name`/`storagePath`).',
    type: ValidationProblemDetailsDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description: 'The caller is not the applicant (`ENTITY_NOT_OWNER`).',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description:
      'No application exists for the given id (`ONBOARDING_APPLICATION_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  addDocument(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: RegisterDocumentDto,
  ): Promise<ApplicationDocumentDto> {
    return this.onboarding.addDocument(user, id, dto);
  }

  @Post(':id/submit')
  @ApiParam({
    name: 'id',
    description: 'The onboarding application id (UUID).',
    format: 'uuid',
  })
  @ApiOperation({
    operationId: 'onboardingSubmit',
    summary: 'Submit an application for review',
    description: [
      'Transitions the application from `draft` or `rejected` to `pending_review` and stamps `submittedAt`, handing it over to PARKIT Ops for review.',
      '',
      'Resubmitting a previously rejected application clears its `rejectionReason`.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: OnboardingApplicationDto })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description: 'The caller is not the applicant (`ENTITY_NOT_OWNER`).',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description:
      'No application exists for the given id (`ONBOARDING_APPLICATION_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  @ApiConflictResponse({
    description:
      'The application is not in a submittable state (`ONBOARDING_INVALID_STATE`).',
    type: ProblemDetailsDto,
  })
  submit(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<OnboardingApplicationDto> {
    return this.onboarding.submit(user, id);
  }
}
