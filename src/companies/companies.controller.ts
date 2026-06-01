import {
  Body,
  Controller,
  Get,
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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Company, User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ScopedCompany } from '../auth/decorators/scoped-company.decorator';
import { CompanyOwnerGuard } from '../auth/guards/company-owner.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AuditEventDto } from '../audit/dto/audit-event.dto';
import { CompanyProfileDto } from '../onboarding/dto/company-profile.dto';
import {
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
} from '../utils/exceptions/dto/problem-details.dto';
import { CompaniesService } from './companies.service';
import { CompanyAuditQueryDto } from './dto/company-audit-query.dto';
import { BranchDto, PaymentMethodSummaryDto } from './dto/company-config.dto';
import { CreateBranchDto } from './dto/create-branch.dto';
import { TogglePaymentMethodDto } from './dto/toggle-payment-method.dto';
import { UpdateCompanyProfileDto } from './dto/update-company-profile.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';

@ApiTags('Companies')
@ApiExtraModels(
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
  CompanyProfileDto,
  BranchDto,
  PaymentMethodSummaryDto,
  AuditEventDto,
)
@Controller('companies')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner')
@ApiBearerAuth('bearer')
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Get('me')
  @ApiOperation({
    operationId: 'companiesGetMine',
    summary: "Get the authenticated owner's company profile",
    description: [
      'Returns the company owned by the authenticated `owner`, regardless of its status (`pending`, `active`, or `suspended`).',
      '',
      'Unlike the other endpoints, this route has **no status gate and no `CompanyOwnerGuard`**: the company is resolved directly from the bearer token (the owner can always read their own company, even while it is still pending approval or has been suspended).',
      '',
      'Use this to bootstrap the owner portal — the returned `status` tells the client which experience to render.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: CompanyProfileDto })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description: 'The authenticated owner has no company (COMPANY_NOT_FOUND).',
    type: ProblemDetailsDto,
  })
  getMyProfile(@CurrentUser() user: User) {
    return this.companies.getMyProfile(user);
  }

  @Patch(':companyId')
  @UseGuards(CompanyOwnerGuard)
  @ApiParam({
    name: 'companyId',
    format: 'uuid',
    description: 'ID of the company to update. Must be owned by the caller.',
  })
  @ApiOperation({
    operationId: 'companiesUpdateProfile',
    summary: 'Update the company profile',
    description: [
      'Edits the editable fields of an **approved** company profile (`legalName`, `email`, `phone`, `address`).',
      '',
      'The `cuit` is immutable (it is the legal identity) and is never accepted here. Every change is written to the audit trail.',
      '',
      'Requires the company to be `active` and the caller to be its owner (platform admins bypass the ownership check).',
    ].join('\n'),
  })
  @ApiOkResponse({ type: CompanyProfileDto })
  @ApiBadRequestResponse({
    description: 'Invalid payload (validation failed).',
    type: ValidationProblemDetailsDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description:
      'The caller is not the company owner (COMPANY_NOT_OWNER), or the company is not active yet (COMPANY_NOT_ACTIVE) or is suspended (COMPANY_SUSPENDED).',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description: 'No company matches the given id (COMPANY_NOT_FOUND).',
    type: ProblemDetailsDto,
  })
  updateProfile(
    @ScopedCompany() company: Company,
    @CurrentUser() user: User,
    @Body() dto: UpdateCompanyProfileDto,
  ) {
    return this.companies.updateProfile(company, user, dto);
  }

  @Get(':companyId/branches')
  @UseGuards(CompanyOwnerGuard)
  @ApiParam({
    name: 'companyId',
    format: 'uuid',
    description:
      'ID of the company whose branches are listed. Must be owned by the caller.',
  })
  @ApiOperation({
    operationId: 'companiesListBranches',
    summary: 'List the company branches',
    description: [
      'Returns every branch (parking lot / tenant) that belongs to the company, oldest first.',
      '',
      'Each branch aggregates its spot counts from its zones: `carSpots`, `motorcycleSpots`, `bicycleSpots` and the derived `totalSpots`.',
      '',
      'Requires the company to be `active` and the caller to be its owner (platform admins bypass the ownership check).',
    ].join('\n'),
  })
  @ApiOkResponse({ type: BranchDto, isArray: true })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description:
      'The caller is not the company owner (COMPANY_NOT_OWNER), or the company is not active yet (COMPANY_NOT_ACTIVE) or is suspended (COMPANY_SUSPENDED).',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description: 'No company matches the given id (COMPANY_NOT_FOUND).',
    type: ProblemDetailsDto,
  })
  listBranches(@ScopedCompany() company: Company) {
    return this.companies.listBranches(company);
  }

  @Post(':companyId/branches')
  @UseGuards(CompanyOwnerGuard)
  @ApiParam({
    name: 'companyId',
    format: 'uuid',
    description:
      'ID of the company the branch is created under. Must be owned by the caller.',
  })
  @ApiOperation({
    operationId: 'companiesCreateBranch',
    summary: 'Create a company branch',
    description: [
      'Creates a new branch (parking lot / tenant) under the company and grants the owner access to it via a membership.',
      '',
      'The branch starts with no zones, so all spot counts (`carSpots`, `motorcycleSpots`, `bicycleSpots`, `totalSpots`) are `0` until zones are configured. The creation is recorded in the audit trail.',
      '',
      'Requires the company to be `active` and the caller to be its owner (platform admins bypass the ownership check).',
    ].join('\n'),
  })
  @ApiCreatedResponse({ type: BranchDto })
  @ApiBadRequestResponse({
    description: 'Invalid payload (validation failed).',
    type: ValidationProblemDetailsDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description:
      'The caller is not the company owner (COMPANY_NOT_OWNER), or the company is not active yet (COMPANY_NOT_ACTIVE) or is suspended (COMPANY_SUSPENDED).',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description: 'No company matches the given id (COMPANY_NOT_FOUND).',
    type: ProblemDetailsDto,
  })
  createBranch(
    @ScopedCompany() company: Company,
    @CurrentUser() user: User,
    @Body() dto: CreateBranchDto,
  ) {
    return this.companies.createBranch(company, user, dto);
  }

  @Patch(':companyId/branches/:tenantId')
  @UseGuards(CompanyOwnerGuard)
  @ApiParam({
    name: 'companyId',
    format: 'uuid',
    description:
      'ID of the company that owns the branch. Must be owned by the caller.',
  })
  @ApiParam({
    name: 'tenantId',
    format: 'uuid',
    description:
      'ID of the branch (tenant) to update. Must belong to the company.',
  })
  @ApiOperation({
    operationId: 'companiesUpdateBranch',
    summary: 'Update a company branch',
    description: [
      'Edits a branch (parking lot / tenant): its `name`, `address`, and operational `status` (`active` or `maintenance`).',
      '',
      'Spot counts are not editable here — they are aggregated from the zones of the branch. The change is recorded in the audit trail.',
      '',
      'Requires the company to be `active` and the caller to be its owner (platform admins bypass the ownership check).',
    ].join('\n'),
  })
  @ApiOkResponse({ type: BranchDto })
  @ApiBadRequestResponse({
    description: 'Invalid payload (validation failed).',
    type: ValidationProblemDetailsDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description:
      'The caller is not the company owner (COMPANY_NOT_OWNER), or the company is not active yet (COMPANY_NOT_ACTIVE) or is suspended (COMPANY_SUSPENDED).',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description:
      'No company matches the given id (COMPANY_NOT_FOUND) or no branch matches the given id in this company (BRANCH_NOT_FOUND).',
    type: ProblemDetailsDto,
  })
  updateBranch(
    @ScopedCompany() company: Company,
    @CurrentUser() user: User,
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateBranchDto,
  ) {
    return this.companies.updateBranch(company, user, tenantId, dto);
  }

  @Get(':companyId/payment-methods')
  @UseGuards(CompanyOwnerGuard)
  @ApiParam({
    name: 'companyId',
    format: 'uuid',
    description:
      'ID of the company whose payment methods are listed. Must be owned by the caller.',
  })
  @ApiOperation({
    operationId: 'companiesListPaymentMethods',
    summary: 'List the company payment methods',
    description: [
      'Returns every payment method configured for the company, oldest first.',
      '',
      'System methods (`mp_transfer`, `cash`) are flagged with `isSystem: true` — they can be enabled or disabled but never deleted.',
      '',
      'Requires the company to be `active` and the caller to be its owner (platform admins bypass the ownership check).',
    ].join('\n'),
  })
  @ApiOkResponse({ type: PaymentMethodSummaryDto, isArray: true })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description:
      'The caller is not the company owner (COMPANY_NOT_OWNER), or the company is not active yet (COMPANY_NOT_ACTIVE) or is suspended (COMPANY_SUSPENDED).',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description: 'No company matches the given id (COMPANY_NOT_FOUND).',
    type: ProblemDetailsDto,
  })
  listPaymentMethods(@ScopedCompany() company: Company) {
    return this.companies.listPaymentMethods(company);
  }

  @Patch(':companyId/payment-methods/:id')
  @UseGuards(CompanyOwnerGuard)
  @ApiParam({
    name: 'companyId',
    format: 'uuid',
    description:
      'ID of the company that owns the payment method. Must be owned by the caller.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description:
      'ID of the payment method to toggle. Must belong to the company.',
  })
  @ApiOperation({
    operationId: 'companiesTogglePaymentMethod',
    summary: 'Enable or disable a company payment method',
    description: [
      'Toggles a payment method on or off via the `enabled` flag. This is the only mutation allowed on a payment method.',
      '',
      'System methods (`mp_transfer`, `cash`) can be disabled but never deleted. The change is recorded in the audit trail.',
      '',
      'Requires the company to be `active` and the caller to be its owner (platform admins bypass the ownership check).',
    ].join('\n'),
  })
  @ApiOkResponse({ type: PaymentMethodSummaryDto })
  @ApiBadRequestResponse({
    description: 'Invalid payload (validation failed).',
    type: ValidationProblemDetailsDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description:
      'The caller is not the company owner (COMPANY_NOT_OWNER), or the company is not active yet (COMPANY_NOT_ACTIVE) or is suspended (COMPANY_SUSPENDED).',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description:
      'No company matches the given id (COMPANY_NOT_FOUND) or no payment method matches the given id in this company (PAYMENT_METHOD_NOT_FOUND).',
    type: ProblemDetailsDto,
  })
  togglePaymentMethod(
    @ScopedCompany() company: Company,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: TogglePaymentMethodDto,
  ) {
    return this.companies.togglePaymentMethod(company, user, id, dto);
  }

  @Get(':companyId/audit')
  @UseGuards(CompanyOwnerGuard)
  @ApiParam({
    name: 'companyId',
    format: 'uuid',
    description:
      'ID of the company whose audit trail is read. Must be owned by the caller.',
  })
  @ApiOperation({
    operationId: 'companiesListAudit',
    summary: 'Read the company audit trail',
    description: [
      'Returns the audit events recorded for the company (profile edits, branch and payment-method changes, etc.), most recent first.',
      '',
      'Supports optional filtering by `severity` and capping the number of returned events with `limit` (defaults to 100).',
      '',
      'Requires the company to be `active` and the caller to be its owner (platform admins bypass the ownership check).',
    ].join('\n'),
  })
  @ApiOkResponse({ type: AuditEventDto, isArray: true })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiForbiddenResponse({
    description:
      'The caller is not the company owner (COMPANY_NOT_OWNER), or the company is not active yet (COMPANY_NOT_ACTIVE) or is suspended (COMPANY_SUSPENDED).',
    type: ProblemDetailsDto,
  })
  @ApiNotFoundResponse({
    description: 'No company matches the given id (COMPANY_NOT_FOUND).',
    type: ProblemDetailsDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid query parameters (validation failed).',
    type: ValidationProblemDetailsDto,
  })
  listAudit(
    @ScopedCompany() company: Company,
    @Query() query: CompanyAuditQueryDto,
  ) {
    return this.companies.listAudit(company, query);
  }
}
