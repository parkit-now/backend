import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBadGatewayResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
} from '../utils/exceptions/dto/problem-details.dto';
import { MpAccountDto } from './dto/mp-account.dto';
import {
  MpOauthCallbackDto,
  MpOauthCallbackResultDto,
} from './dto/mp-oauth-callback.dto';
import { MpAccountsService } from './mp-accounts.service';

/**
 * Callback del OAuth de Mercado Pago.
 *
 * ## 🔴 Por qué esta ruta NO vive bajo `/tenants/:tenantId/*`
 *
 * Es una desviación CONSCIENTE de la convención del repo, no un olvido.
 *
 * Mercado Pago exige que el `redirect_uri` sea una URL **estática**: tiene que
 * coincidir carácter por carácter con la registrada en el panel de la
 * aplicación, y esa registración es una sola para todo Parkit. Meter el tenant
 * en la ruta (`/tenants/<uuid>/mercado-pago/oauth/callback`) daría una URL
 * distinta por playa, o sea infinitas, o sea ninguna registrable.
 *
 * Tampoco hace falta: el tenant NO se toma de la URL, se lee de la fila de
 * `mp_oauth_states` que apunta el `state`. Esa fila la escribió el backend al
 * arrancar el flujo, así que el cliente no puede elegir a qué playa vincular
 * aunque quiera.
 *
 * ## 🔴 Por qué SÓLO `JwtAuthGuard`, sin `TenantMembershipGuard`
 *
 * Porque ese guard **falla cerrado con 403 para todo el que no sea admin
 * global cuando la ruta no tiene `:tenantId`**. Está escrito explícitamente en
 * `src/auth/guards/tenant-membership.guard.ts:55-62`:
 *
 *     if (!tenantId) {
 *       // Fail closed: a misconfigured route without :tenantId must not pass.
 *       throw this.forbidden(...);
 *     }
 *
 * Es el comportamiento correcto del guard —una ruta tenant-scopeada a la que
 * se le olvidó el parámetro tiene que romper, no abrirse— y es exactamente por
 * eso que no puede ir acá: esta ruta no tiene `:tenantId` A PROPÓSITO. Ponerlo
 * haría que la vinculación funcione sólo para los admins de plataforma y
 * devuelva 403 a todos los dueños, que son justamente los únicos que la usan.
 *
 * El chequeo que el guard haría lo hace el service, con la misma fuente de
 * verdad (`PermissionsService.canManageEntity`) y sobre el `tenant_id` que
 * salió del `state`. Ver `MpAccountsService.handleCallback`.
 *
 * El precedente de controller sin guard de clase es
 * `src/password-recovery/password-recovery.controller.ts`.
 *
 * ## Cómo llega el request
 *
 * El `redirect_uri` registrado en Mercado Pago apunta al FRONT, no a este
 * endpoint: Mercado Pago redirige el navegador del dueño con `?code=...&state=...`,
 * el panel toma esos dos parámetros y los POSTea acá con el bearer del usuario
 * ya logueado. Por eso el callback puede exigir JWT: quien llama no es Mercado
 * Pago, es nuestro propio front.
 */
@ApiTags('Mercado Pago')
@ApiExtraModels(
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
  MpAccountDto,
  MpOauthCallbackResultDto,
)
@Controller('mercado-pago/oauth')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('bearer')
export class MpOauthController {
  constructor(private readonly accounts: MpAccountsService) {}

  @Post('callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'mercadoPagoOauthCallback',
    summary: 'Finish the Mercado Pago linking flow',
    description: [
      'Exchanges the `state` atomically (single use), verifies the caller still owns the entity that started the flow, swaps the `authorization_code` for OAuth tokens, provisions the Mercado Pago `Store` and `POS`, stores the encrypted tokens and creates the `mercadopago_qr` payment method.',
      '',
      'The route deliberately carries no `:tenantId`: the entity comes from the stored `state`, because Mercado Pago requires a static `redirect_uri`.',
      '',
      'Every `state` failure — unknown, already consumed, expired, or belonging to somebody else — answers the same generic `MP_OAUTH_STATE_INVALID`, so the endpoint cannot be used as an oracle to probe other people flows.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: MpOauthCallbackResultDto })
  @ApiBadRequestResponse({
    description:
      'The `state` is unknown, expired, already used, or does not belong to the caller (MP_OAUTH_STATE_INVALID); or the payload is malformed.',
    type: ProblemDetailsDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'The entity address is incomplete (MP_ENTITY_ADDRESS_INCOMPLETE).',
    type: ProblemDetailsDto,
  })
  @ApiBadGatewayResponse({
    description:
      'Mercado Pago rejected or could not serve the token exchange, the store or the POS creation (MP_OAUTH_CODE_EXCHANGE_FAILED, MP_STORE_CREATE_FAILED, MP_POS_CREATE_FAILED). Nothing is persisted in that case.',
    type: ProblemDetailsDto,
  })
  handleCallback(
    @Body() dto: MpOauthCallbackDto,
    @CurrentUser() user: User,
  ): Promise<MpOauthCallbackResultDto> {
    return this.accounts.handleCallback(dto.code, dto.state, user);
  }
}
