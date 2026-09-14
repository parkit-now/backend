import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
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
import {
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
} from '../utils/exceptions/dto/problem-details.dto';
import { MpAccountDto } from './dto/mp-account.dto';
import {
  CreateMpAuthorizationUrlDto,
  MpAuthorizationUrlDto,
} from './dto/mp-authorization-url.dto';
import { MpAccountsService } from './mp-accounts.service';

/**
 * Gestión de la cuenta de Mercado Pago de UNA playa.
 *
 * Todo lo que puede scopearse por playa vive acá, bajo `/tenants/:tenantId/*`,
 * que es la convención del repo y lo que habilita el par
 * `TenantMembershipGuard` + `TenantInterceptor`. La única ruta de la
 * integración que NO puede seguir esa forma es el callback del OAuth — ver
 * `MpOauthController` y el porqué escrito ahí.
 *
 * Las escrituras son `owner` (los admins de plataforma pasan igual, vía
 * `PermissionsService.canManageEntity`): vincular una cuenta de cobro es mover
 * a dónde va la plata, no es configuración de operación.
 */
@ApiTags('Mercado Pago')
@ApiExtraModels(
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
  MpAccountDto,
  MpAuthorizationUrlDto,
)
@Controller('tenants/:tenantId/mercado-pago')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('bearer')
@ApiParam({
  name: 'tenantId',
  format: 'uuid',
  description: 'ID of the entity (parking lot / tenant).',
})
@ApiUnauthorizedResponse({
  description: 'Missing, malformed, or expired bearer token.',
  type: ProblemDetailsDto,
})
@ApiForbiddenResponse({
  description:
    'The caller is authenticated but is not a member of the `:tenantId` entity, or is not an `owner` for a write operation.',
  type: ProblemDetailsDto,
})
export class MpAccountsController {
  constructor(private readonly accounts: MpAccountsService) {}

  @Get('account')
  @ApiOperation({
    operationId: 'mercadoPagoGetAccount',
    summary: 'Get the Mercado Pago account linked to the entity',
    description: [
      'Returns the link status of the entity plus the identifiers of its Mercado Pago `Store` and `POS` and the URLs of the QR code (image and printable PDF).',
      '',
      'NEVER returns the OAuth tokens, not even encrypted or truncated.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: MpAccountDto })
  @ApiNotFoundResponse({
    description:
      'The entity has no Mercado Pago account linked (MP_NOT_LINKED).',
    type: ProblemDetailsDto,
  })
  getAccount(@Param('tenantId') tenantId: string): Promise<MpAccountDto> {
    return this.accounts.getAccount(tenantId);
  }

  @Post('oauth/authorization-url')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    operationId: 'mercadoPagoCreateAuthorizationUrl',
    summary: 'Start the Mercado Pago linking flow',
    description: [
      'Creates a single-use `state` with its PKCE `code_verifier` (valid for 10 minutes) and returns the Mercado Pago authorization URL the owner must open.',
      '',
      'The entity must already have a complete structured address (street, number, city, province): Mercado Pago requires it for the store location, and failing here saves the owner a pointless round trip to the consent screen.',
      '',
      'An entity that already has an active link must be unlinked first. Re-running the flow on a `token_expired` or `revoked` account is the supported way back to `linked`.',
    ].join('\n'),
  })
  @ApiCreatedResponse({ type: MpAuthorizationUrlDto })
  @ApiBadRequestResponse({
    description:
      'Invalid payload — typically a `returnPath` that is not an internal path.',
    type: ValidationProblemDetailsDto,
  })
  @ApiConflictResponse({
    description:
      'The entity already has an active Mercado Pago account (MP_ALREADY_LINKED).',
    type: ProblemDetailsDto,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'The entity address is incomplete (MP_ENTITY_ADDRESS_INCOMPLETE).',
    type: ProblemDetailsDto,
  })
  createAuthorizationUrl(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: User,
    @Body() dto: CreateMpAuthorizationUrlDto,
  ): Promise<MpAuthorizationUrlDto> {
    return this.accounts.buildAuthorizationUrl(tenantId, user, dto);
  }

  @Delete('account')
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'mercadoPagoUnlinkAccount',
    summary: 'Unlink the Mercado Pago account of the entity',
    description: [
      'Marks the account as revoked and DISABLES the `mercadopago_qr` payment method — it is never deleted, because closed shifts and past transactions still reference it.',
      '',
      'Linking again later re-enables the same payment method, keeping whatever name the owner gave it.',
    ].join('\n'),
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({
    description:
      'The entity has no Mercado Pago account linked (MP_NOT_LINKED).',
    type: ProblemDetailsDto,
  })
  async unlinkAccount(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: User,
  ): Promise<void> {
    await this.accounts.unlink(tenantId, user);
  }

  @Post('pos/resync')
  @EntityRole(MembershipRole.owner)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'mercadoPagoResyncPos',
    summary: 'Re-read the POS from Mercado Pago and refresh the QR URLs',
    description: [
      'Asks Mercado Pago for the current state of the entity POS and stores the fresh QR URLs. Mercado Pago owns those URLs and can regenerate them, so our copy is a cache, not the source of truth.',
      '',
      'Requires an operational link: an expired or revoked account has to be authorized again first.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: MpAccountDto })
  @ApiNotFoundResponse({
    description:
      'The entity has no Mercado Pago account linked (MP_NOT_LINKED).',
    type: ProblemDetailsDto,
  })
  @ApiConflictResponse({
    description:
      'The link is not operational (MP_ACCOUNT_TOKEN_EXPIRED, MP_ACCOUNT_REVOKED).',
    type: ProblemDetailsDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Mercado Pago is down or rate-limiting us (MP_UNAVAILABLE).',
    type: ProblemDetailsDto,
  })
  resyncPos(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: User,
  ): Promise<MpAccountDto> {
    return this.accounts.resyncPos(tenantId, user);
  }
}
