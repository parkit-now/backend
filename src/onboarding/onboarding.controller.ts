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
import { CompanyProfileDto } from './dto/company-profile.dto';
import { CreateCompanyOnboardingDto } from './dto/create-company-onboarding.dto';
import {
  CompanyDocumentDto,
  OnboardingApplicationDto,
  OnboardingStateDto,
} from './dto/onboarding-response.dto';
import { RegisterDocumentDto } from './dto/register-document.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { OnboardingService } from './onboarding.service';

@ApiTags('Onboarding')
@ApiExtraModels(
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
  OnboardingStateDto,
  OnboardingApplicationDto,
  CompanyProfileDto,
  CompanyDocumentDto,
)
@Controller('onboarding')
@UseGuards(JwtAuthGuard, RolesGuard)
// `driver` is allowed so a freshly registered user can start onboarding;
// creating the company promotes them to `owner` (see OnboardingService).
@Roles('owner', 'driver')
@ApiBearerAuth('bearer')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get('me')
  @ApiOperation({
    operationId: 'onboardingGetState',
    summary: "Get the authenticated owner's onboarding state",
    description: [
      'Returns the company owned by the caller together with its latest onboarding application.',
      '',
      'This is the entry point of the owner-facing onboarding flow. A parking-lot owner registers a single Company (legal entity), declares one or more branches, attaches document metadata, and submits the application for PARKIT Ops review.',
      '',
      'Both `company` and `application` are `null` when the owner has not started onboarding yet (no company created). Use this to decide whether to render the create-company step or resume an existing application.',
      '',
      'An application cycles `draft` → `pending_review` → `approved`/`rejected`. Rejected applications can be edited and resubmitted.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: OnboardingStateDto })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description: 'The caller is authenticated but is not an `owner`.',
    type: ProblemDetailsDto,
  })
  getMe(@CurrentUser() user: User): Promise<OnboardingStateDto> {
    return this.onboarding.getMe(user);
  }

  @Post('company')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    operationId: 'onboardingCreateCompany',
    summary: 'Create the company and open a draft application',
    description: [
      'Step 1 of onboarding. Creates the Company (legal entity: `legalName`, `cuit`, `email`, `phone`, `address`) with `status=pending`, and opens a matching OnboardingApplication with `status=draft`.',
      '',
      '**One company per owner.** If the caller already owns a company, the request is rejected with a conflict — there is no second company to create.',
      '',
      'The returned state contains the freshly created company and its empty draft application (zero declared branches, zero documents). Subsequent steps add branches/documents via `PATCH /onboarding/application/:id` and `POST /onboarding/application/:id/documents`.',
    ].join('\n'),
  })
  @ApiCreatedResponse({ type: OnboardingStateDto })
  @ApiBadRequestResponse({
    description:
      'Invalid payload (validation: missing fields, malformed CUIT/email, etc.).',
    type: ValidationProblemDetailsDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description: 'The caller is authenticated but is not an `owner`.',
    type: ProblemDetailsDto,
  })
  @ApiConflictResponse({
    description:
      'The owner already has a company (`COMPANY_ALREADY_EXISTS`). Only one company per owner is allowed.',
    type: ProblemDetailsDto,
  })
  createCompany(
    @CurrentUser() user: User,
    @Body() dto: CreateCompanyOnboardingDto,
  ): Promise<OnboardingStateDto> {
    return this.onboarding.createCompany(user, dto);
  }

  @Patch('application/:id')
  @ApiParam({
    name: 'id',
    description: 'The onboarding application id (UUID).',
    format: 'uuid',
    example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  })
  @ApiOperation({
    operationId: 'onboardingUpdateApplication',
    summary: 'Edit a draft or rejected application',
    description: [
      'Updates the company data and/or the declared branches of an application that is still editable.',
      '',
      '**Editable states only:** `draft` and `rejected`. An application in `pending_review` or `approved` can no longer be edited and the request is rejected with a conflict. Editing a rejected application is how an owner fixes the issues raised by PARKIT Ops before resubmitting.',
      '',
      'All fields are optional (partial update). Company fields (`legalName`, `cuit`, `email`, `phone`, `address`) patch the underlying company; `declaredBranches` fully replaces the declared branch list. Each branch carries a `name` and `address`. On approval these declared branches are materialized as real lots.',
      '',
      'Returns the updated onboarding state.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: OnboardingStateDto })
  @ApiBadRequestResponse({
    description:
      'Invalid payload (validation: malformed CUIT/email, missing required branch fields, etc.).',
    type: ValidationProblemDetailsDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description:
      'The caller is not an `owner`, or does not own this application (`COMPANY_NOT_OWNER`).',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description:
      'No application exists for the given id (`ONBOARDING_APPLICATION_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  @ApiConflictResponse({
    description:
      'The application is not in an editable state (`ONBOARDING_INVALID_STATE`); only `draft`/`rejected` applications can be edited.',
    type: ProblemDetailsDto,
  })
  updateApplication(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateApplicationDto,
  ): Promise<OnboardingStateDto> {
    return this.onboarding.updateApplication(user, id, dto);
  }

  @Post('application/:id/documents')
  @HttpCode(HttpStatus.CREATED)
  @ApiParam({
    name: 'id',
    description: 'The onboarding application id (UUID).',
    format: 'uuid',
    example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  })
  @ApiOperation({
    operationId: 'onboardingAddDocument',
    summary: 'Register document metadata for an application',
    description: [
      'Registers the metadata of a supporting document attached to the application.',
      '',
      '**The binary is uploaded out-of-band.** The client uploads the file directly to Supabase Storage; this endpoint only persists its metadata (`name`, `storagePath`, optional `mimeType`). The `storagePath` is the object key in storage.',
      '',
      'The document is linked to the application and its company. Returns the created document record.',
    ].join('\n'),
  })
  @ApiCreatedResponse({ type: CompanyDocumentDto })
  @ApiBadRequestResponse({
    description: 'Invalid payload (validation: missing `name`/`storagePath`).',
    type: ValidationProblemDetailsDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description:
      'The caller is not an `owner`, or does not own this application (`COMPANY_NOT_OWNER`).',
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
  ): Promise<CompanyDocumentDto> {
    return this.onboarding.addDocument(user, id, dto);
  }

  @Post('application/:id/submit')
  @ApiParam({
    name: 'id',
    description: 'The onboarding application id (UUID).',
    format: 'uuid',
    example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  })
  @ApiOperation({
    operationId: 'onboardingSubmit',
    summary: 'Submit an application for review',
    description: [
      'Transitions the application from `draft` or `rejected` to `pending_review` and stamps `submittedAt`, handing it over to PARKIT Ops for review.',
      '',
      '**Preconditions:** the application must be in an editable state (`draft`/`rejected`) and declare at least one branch. Submitting an application with zero declared branches is rejected with a bad request (`ONBOARDING_NOT_SUBMITTABLE`); submitting one that is already in `pending_review`/`approved` is rejected with a conflict (`ONBOARDING_INVALID_STATE`).',
      '',
      'Resubmitting a previously rejected application clears its `rejectionReason`. Returns the updated onboarding state.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: OnboardingStateDto })
  @ApiBadRequestResponse({
    description:
      'The application declares no branches and cannot be submitted (`ONBOARDING_NOT_SUBMITTABLE`).',
    type: ProblemDetailsDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description:
      'The caller is not an `owner`, or does not own this application (`COMPANY_NOT_OWNER`).',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description:
      'No application exists for the given id (`ONBOARDING_APPLICATION_NOT_FOUND`).',
    type: ProblemDetailsDto,
  })
  @ApiConflictResponse({
    description:
      'The application is not in a submittable state (`ONBOARDING_INVALID_STATE`); only `draft`/`rejected` applications can be submitted.',
    type: ProblemDetailsDto,
  })
  submit(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<OnboardingStateDto> {
    return this.onboarding.submit(user, id);
  }
}
