import {
  Body,
  Controller,
  Delete,
  Get,
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
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { MembershipRole, type User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { EntityRole } from '../auth/decorators/entity-role.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
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

@ApiTags('ARCA')
@ApiBearerAuth('bearer')
@Controller('tenants/:tenantId/arca/accounts')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
export class ArcaSelectedAccountsController {
  constructor(private readonly accounts: ArcaAccountsService) {}

  @Get()
  @ApiOkResponse({ type: ArcaAccountDto, isArray: true })
  list(@Param('tenantId') tenantId: string) {
    return this.accounts.listAccounts(tenantId);
  }

  @Post()
  @EntityRole(MembershipRole.owner)
  @ApiCreatedResponse({ type: ArcaAccountDto })
  create(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateArcaAccountDto,
  ) {
    return this.accounts.create(tenantId, dto);
  }

  @Get(':accountId')
  @ApiOkResponse({ type: ArcaAccountDto })
  get(
    @Param('tenantId') tenantId: string,
    @Param('accountId', ParseUUIDPipe) id: string,
  ) {
    return this.accounts.getAccount(tenantId, id);
  }

  @Patch(':accountId')
  @EntityRole(MembershipRole.owner)
  @ApiOkResponse({ type: ArcaAccountDto })
  update(
    @Param('tenantId') tenantId: string,
    @Param('accountId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateArcaAccountDto,
  ) {
    return this.accounts.update(tenantId, dto, id);
  }

  @Get(':accountId/csr')
  @EntityRole(MembershipRole.owner)
  @ApiOkResponse({ type: ArcaCsrDto })
  csr(
    @Param('tenantId') tenantId: string,
    @Param('accountId', ParseUUIDPipe) id: string,
  ) {
    return this.accounts.getCsr(tenantId, id);
  }

  @Post(':accountId/certificate')
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ArcaCertificateResultDto })
  certificate(
    @Param('tenantId') tenantId: string,
    @Param('accountId', ParseUUIDPipe) id: string,
    @Body() dto: UploadArcaCertificateDto,
  ) {
    return this.accounts.uploadCertificate(tenantId, dto, id);
  }

  @Get(':accountId/reusable-certificates')
  @EntityRole(MembershipRole.owner)
  @ApiOkResponse({ type: ArcaReusableCertificateDto, isArray: true })
  reusable(
    @Param('tenantId') tenantId: string,
    @Param('accountId', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return this.accounts.listReusableCertificates(tenantId, user, id);
  }

  @Post(':accountId/reuse-certificate')
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ArcaAccountDto })
  reuse(
    @Param('tenantId') tenantId: string,
    @Param('accountId', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Body() dto: ReuseArcaCertificateDto,
  ) {
    return this.accounts.reuseCertificate(tenantId, user, dto, id);
  }

  @Post(':accountId/sales-point')
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ArcaAccountDto })
  salesPoint(
    @Param('tenantId') tenantId: string,
    @Param('accountId', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Body() dto: SetArcaSalesPointDto,
  ) {
    return this.accounts.setSalesPoint(tenantId, user, dto, id);
  }

  @Get(':accountId/renewal/csr')
  @EntityRole(MembershipRole.owner)
  @ApiOkResponse({ type: ArcaCsrDto })
  renewalCsr(
    @Param('tenantId') tenantId: string,
    @Param('accountId', ParseUUIDPipe) id: string,
  ) {
    return this.accounts.getRenewalCsr(tenantId, id);
  }

  @Post(':accountId/renewal/certificate')
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ArcaAccountDto })
  renewalCertificate(
    @Param('tenantId') tenantId: string,
    @Param('accountId', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Body() dto: UploadArcaCertificateDto,
  ) {
    return this.accounts.uploadRenewalCertificate(tenantId, user, dto, id);
  }

  @Delete(':accountId')
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.NO_CONTENT)
  unlink(
    @Param('tenantId') tenantId: string,
    @Param('accountId', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return this.accounts.unlink(tenantId, user, id);
  }
}
