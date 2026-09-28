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
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
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
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { MembershipRole } from '@prisma/client';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { EntityRole } from '../auth/decorators/entity-role.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { ProblemDetailsDto } from '../utils/exceptions/dto/problem-details.dto';
import { ArcaAccountsService } from './arca-accounts.service';
import {
  ArcaAccountDto,
  ArcaCertificateResultDto,
  ArcaCsrDto,
  ArcaReusableCertificateDto,
  CreateArcaAccountDto,
  ReuseArcaCertificateDto,
  SetArcaSalesPointDto,
  UpdateArcaAccountDto,
  UploadArcaCertificateDto,
} from './dto/arca-account.dto';

/**
 * Vinculación de ARCA de UNA playa: el wizard del panel web (CUIT →
 * certificado → punto de venta), la configuración y el desvincular.
 *
 * Leer la cuenta lo puede cualquier miembro (el desktop y el panel del
 * operador muestran si se factura); todo lo que escribe es `owner`: vincular
 * es emitir comprobantes con efecto fiscal a nombre del CUIT del dueño.
 */
@ApiTags('ARCA')
@ApiExtraModels(ProblemDetailsDto, ArcaAccountDto)
@Controller('tenants/:tenantId/arca')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('bearer')
@ApiParam({
  name: 'tenantId',
  format: 'uuid',
  description: 'ID of the entity (parking lot / tenant).',
})
@ApiUnauthorizedResponse({ type: ProblemDetailsDto })
@ApiForbiddenResponse({
  description:
    'Not a member of the entity, or not an `owner` for a write operation.',
  type: ProblemDetailsDto,
})
export class ArcaAccountsController {
  constructor(private readonly accounts: ArcaAccountsService) {}

  @Get('account')
  @ApiOperation({
    operationId: 'arcaGetAccount',
    summary: 'Get the ARCA account of the entity',
    description:
      'The 404 ARCA_NOT_LINKED is the happy path of "not linked yet" (an unlinked account also answers 404). A `pending_*` status means the linking wizard is half way: resume it from that step.',
  })
  @ApiOkResponse({ type: ArcaAccountDto })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  getAccount(@Param('tenantId') tenantId: string): Promise<ArcaAccountDto> {
    return this.accounts.getAccount(tenantId);
  }

  @Post('account')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    operationId: 'arcaCreateAccount',
    summary: 'Wizard step 1: CUIT and IIBB, generates the certificate request',
    description:
      'Validates the CUIT check digit, generates the RSA key (kept encrypted, never returned) and the CSR, and leaves the account in `pending_certificate`. Calling it again while the wizard is in progress starts over, discarding the previous key and certificate.',
  })
  @ApiCreatedResponse({ type: ArcaAccountDto })
  @ApiConflictResponse({
    description: 'ARCA_ALREADY_LINKED.',
    type: ProblemDetailsDto,
  })
  @ApiUnprocessableEntityResponse({
    description: 'ARCA_CUIT_INVALID.',
    type: ProblemDetailsDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'ARCA_UNAVAILABLE: invoicing is off in this environment.',
    type: ProblemDetailsDto,
  })
  create(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateArcaAccountDto,
  ): Promise<ArcaAccountDto> {
    return this.accounts.create(tenantId, dto);
  }

  @Patch('account')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    operationId: 'arcaUpdateAccount',
    summary: 'Update the IVA rate and, in homologación, the fiscal data',
    description:
      'In production the fiscal data comes from ARCA’s registry: sending it answers 409 ARCA_LINK_STEP_INVALID (`fiscalDataEditable` tells the UI).',
  })
  @ApiOkResponse({ type: ArcaAccountDto })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  @ApiConflictResponse({
    description: 'ARCA_LINK_STEP_INVALID.',
    type: ProblemDetailsDto,
  })
  update(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateArcaAccountDto,
  ): Promise<ArcaAccountDto> {
    return this.accounts.update(tenantId, dto);
  }

  @Get('account/csr')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    operationId: 'arcaGetCsr',
    summary: 'Download the certificate request (CSR) to upload to ARCA',
  })
  @ApiOkResponse({ type: ArcaCsrDto })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  @ApiConflictResponse({
    description: 'ARCA_LINK_STEP_INVALID.',
    type: ProblemDetailsDto,
  })
  getCsr(@Param('tenantId') tenantId: string): Promise<ArcaCsrDto> {
    return this.accounts.getCsr(tenantId);
  }

  @Post('account/certificate')
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'arcaUploadCertificate',
    summary: 'Wizard step 2: verify the certificate ARCA issued',
    description:
      'Checks the certificate (CUIT, expiry, that it was issued for Parkit’s CSR), logs in to ARCA for both services and reads the taxpayer registry. Leaves the account in `pending_sales_point`. In homologación the registry usually has no data (`padronFound: false`): load it with PATCH.',
  })
  @ApiOkResponse({ type: ArcaCertificateResultDto })
  @ApiConflictResponse({
    description: 'ARCA_LINK_STEP_INVALID.',
    type: ProblemDetailsDto,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'ARCA_CERT_INVALID, ARCA_CERT_CUIT_MISMATCH, ARCA_CERT_KEY_MISMATCH, ARCA_CERT_EXPIRED, ARCA_CERT_NOT_AUTHORIZED, ARCA_PADRON_NOT_FOUND.',
    type: ProblemDetailsDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'ARCA_UNAVAILABLE.',
    type: ProblemDetailsDto,
  })
  uploadCertificate(
    @Param('tenantId') tenantId: string,
    @Body() dto: UploadArcaCertificateDto,
  ): Promise<ArcaCertificateResultDto> {
    return this.accounts.uploadCertificate(tenantId, dto);
  }

  @Get('account/reusable-certificates')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    operationId: 'arcaListReusableCertificates',
    summary: 'Other entities of the caller linked with the same CUIT',
  })
  @ApiOkResponse({ type: ArcaReusableCertificateDto, isArray: true })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  listReusable(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: User,
  ): Promise<ArcaReusableCertificateDto[]> {
    return this.accounts.listReusableCertificates(tenantId, user);
  }

  @Post('account/reuse-certificate')
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'arcaReuseCertificate',
    summary: 'Wizard step 2 shortcut: use the certificate of another entity',
    description:
      'Copies the certificate and fiscal data of another entity the caller owns, linked with the same CUIT. The sales point is not copied: each entity has its own.',
  })
  @ApiOkResponse({ type: ArcaAccountDto })
  @ApiConflictResponse({
    description: 'ARCA_LINK_STEP_INVALID.',
    type: ProblemDetailsDto,
  })
  reuseCertificate(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: User,
    @Body() dto: ReuseArcaCertificateDto,
  ): Promise<ArcaAccountDto> {
    return this.accounts.reuseCertificate(tenantId, user, dto);
  }

  @Post('account/sales-point')
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'arcaSetSalesPoint',
    summary: 'Wizard step 3: verify the sales point and finish linking',
    description:
      'The sales point must be a web services one (listed by FEParamGetPtosVenta, not blocked) and `getLastVoucher` must answer for the entity’s letter. Leaves the account `linked`.',
  })
  @ApiOkResponse({ type: ArcaAccountDto })
  @ApiConflictResponse({
    description: 'ARCA_LINK_STEP_INVALID.',
    type: ProblemDetailsDto,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'ARCA_POS_NOT_FOUND, ARCA_POS_DISABLED, ARCA_PADRON_NOT_FOUND.',
    type: ProblemDetailsDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'ARCA_UNAVAILABLE.',
    type: ProblemDetailsDto,
  })
  setSalesPoint(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: User,
    @Body() dto: SetArcaSalesPointDto,
  ): Promise<ArcaAccountDto> {
    return this.accounts.setSalesPoint(tenantId, user, dto);
  }

  @Get('account/renewal/csr')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    operationId: 'arcaGetRenewalCsr',
    summary: 'Download the request (CSR) to renew the certificate',
    description:
      'Same alias as the current certificate: in ARCA it goes to «Agregar certificado» on that alias, which keeps the associated services. Prepared by the daily job 30 days before expiry, or generated on the spot. The current certificate keeps working until the renewed one is uploaded.',
  })
  @ApiOkResponse({ type: ArcaCsrDto })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  @ApiConflictResponse({
    description: 'ARCA_LINK_STEP_INVALID: the account is not linked.',
    type: ProblemDetailsDto,
  })
  getRenewalCsr(@Param('tenantId') tenantId: string): Promise<ArcaCsrDto> {
    return this.accounts.getRenewalCsr(tenantId);
  }

  @Post('account/renewal/certificate')
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'arcaUploadRenewalCertificate',
    summary: 'Verify the renewed certificate and switch to it',
    description:
      'Checks it like the wizard does, but against the renewal key, and logs in to ARCA with it. Switches the certificate in every entity that shares it; an entity in `cert_expired` goes back to `linked`.',
  })
  @ApiOkResponse({ type: ArcaAccountDto })
  @ApiConflictResponse({
    description: 'ARCA_LINK_STEP_INVALID.',
    type: ProblemDetailsDto,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'ARCA_CERT_INVALID, ARCA_CERT_CUIT_MISMATCH, ARCA_CERT_KEY_MISMATCH, ARCA_CERT_EXPIRED, ARCA_CERT_NOT_AUTHORIZED.',
    type: ProblemDetailsDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'ARCA_UNAVAILABLE.',
    type: ProblemDetailsDto,
  })
  uploadRenewalCertificate(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: User,
    @Body() dto: UploadArcaCertificateDto,
  ): Promise<ArcaAccountDto> {
    return this.accounts.uploadRenewalCertificate(tenantId, user, dto);
  }

  @Delete('account')
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'arcaUnlinkAccount',
    summary: 'Unlink ARCA (or cancel a half-done wizard)',
    description:
      'Deletes the key and the certificate, keeps every invoice already issued, and sets every payment method of the entity to `invoiceMode = none`.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  async unlink(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: User,
  ): Promise<void> {
    await this.accounts.unlink(tenantId, user);
  }
}
