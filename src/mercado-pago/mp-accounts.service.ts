import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { MpAccountStatus, PaymentMethodType } from '@prisma/client';
import type { MpAccount, Prisma, Tenant, User } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuditActions, AuditService } from '../audit/audit.service';
import { PermissionsService } from '../auth/permissions.service';
import { PrismaService } from '../database/prisma.service';
import {
  describeMissingAddressFields,
  missingDeclaredAddressFields,
  toEntityAddressDto,
} from '../entities/tenant-address';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { MpAccountDto } from './dto/mp-account.dto';
import {
  CreateMpAuthorizationUrlDto,
  MpAuthorizationUrlDto,
  isSafeReturnPath,
} from './dto/mp-authorization-url.dto';
import { MpOauthCallbackResultDto } from './dto/mp-oauth-callback.dto';
import { toMpAccountDto } from './mercado-pago.mappers';
import { MpApiClient, type MpPos, type MpStoreLocation } from './mp-api.client';
import { MpCryptoService } from './mp-crypto.service';
import { MpConfigService } from './mp-config.service';
import { MpTokenService } from './mp-token.service';

/**
 * Host de AUTORIZACIÓN de Mercado Pago. OJO: NO es `MP_API_BASE_URL`.
 *
 * `api.mercadopago.com` es la API que consume el backend; `auth.mercadopago.com`
 * es la pantalla de consentimiento a la que va el navegador del dueño. Son dos
 * hosts distintos y derivar uno del otro es un bug esperando: apuntar
 * `MP_API_BASE_URL` a un mock para pruebas manuales no tiene por qué mandar al
 * dueño a autorizar contra ese mock.
 */
const MP_AUTHORIZATION_URL = 'https://auth.mercadopago.com/authorization';

/**
 * TTL del `state`: 10 minutos, el mismo que el `authorization_code` de Mercado
 * Pago. Guardar el state más tiempo del que vive el código sólo agranda la
 * ventana de replay sin habilitar ningún flujo que hoy no funcione.
 */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Bytes aleatorios del `code_verifier` de PKCE. 32 bytes en base64url dan 43
 * caracteres, que es EXACTAMENTE el mínimo que exige RFC 7636 (43-128).
 */
const CODE_VERIFIER_BYTES = 32;

/**
 * Nombre del método de pago que se crea al vincular. En español porque es
 * user-facing y porque el arqueo del desktop se apoya en el nombre (ver la
 * cabecera de `prisma/schema/global/payment-methods.prisma`).
 */
export const MP_PAYMENT_METHOD_NAME = 'Mercado Pago QR';

/** Largo máximo del `name` de un POS según la documentación de Mercado Pago. */
const MAX_POS_NAME_LENGTH = 45;

/** Largo máximo del `external_id` de un POS según Mercado Pago. */
const MAX_POS_EXTERNAL_ID_LENGTH = 40;

/** Caracteres que Mercado Pago acepta en el `name` de un POS. */
const POS_NAME_ALLOWED = /[^A-Za-z0-9 _-]/g;

/** Instance de los ProblemDetails de las rutas scopeadas por playa. */
const TENANT_INSTANCE = '/tenants/:tenantId/mercado-pago';

/** Instance de los ProblemDetails del callback, que NO lleva `:tenantId`. */
const CALLBACK_INSTANCE = '/mercado-pago/oauth/callback';

/**
 * Vinculación de la cuenta de Mercado Pago de una playa: OAuth, alta del
 * Store/POS que genera el QR, y el método de pago asociado.
 *
 * ## 🔴 Aislamiento multi-tenant MANUAL
 *
 * `MpAccount` y `MpOauthState` viven en `prisma/schema/global/` y NO están en
 * `TENANT_MODELS` (`src/database/prisma-tenant.ts`), así que la extensión de
 * Prisma NO inyecta el `WHERE tenant_id`. Es el MISMO caso que
 * `payment_methods` en `EntitiesService` (ver su docblock,
 * `src/entities/entities.service.ts:22-27`).
 *
 * Consecuencia práctica, y no hay red abajo: **cada query de este service
 * filtra a mano por el `:tenantId` de la ruta**, que el `TenantMembershipGuard`
 * ya validó. Olvidarse de ese filtro en UNA query es una fuga de datos entre
 * playas — y no la va a atajar ni Prisma ni RLS, porque estas dos tablas son
 * backend-only con RLS sin policies.
 *
 * El motivo de que sean globales está escrito en las migraciones: el cron de
 * refresh de tokens (B2c) las barre cross-tenant, sin request y por lo tanto
 * sin tenant en el `AsyncLocalStorage`; y el callback de OAuth llega sin
 * `:tenantId` en la ruta porque la playa se deduce de `mp_oauth_states`.
 *
 * ## Orden de las llamadas externas
 *
 * Las tres llamadas a Mercado Pago (token, store, pos) ocurren AFUERA de la
 * transacción de base, y la transacción se abre recién con los tres resultados
 * en la mano. Dos motivos:
 *
 *  1. Nunca se sostiene una transacción de Postgres a través de un round-trip
 *     de red: con timeout de 10s por llamada, eso es hasta 30s de locks
 *     tomados y una conexión del pool secuestrada.
 *  2. Si Mercado Pago falla, no se escribió NADA: no queda una cuenta a medio
 *     vincular que el panel muestre como si anduviera. Hay un test que lo
 *     afirma.
 */
@Injectable()
export class MpAccountsService {
  private readonly logger = new Logger(MpAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
    private readonly config: MpConfigService,
    private readonly crypto: MpCryptoService,
    private readonly mpApi: MpApiClient,
    // 🔴 La dependencia va SIEMPRE en este sentido: este service usa el de
    // tokens, nunca al revés. `MpTokenService` no sabe nada de OAuth ni de
    // Store/POS justamente para que no se arme el ciclo.
    private readonly tokens: MpTokenService,
  ) {}

  /** La cuenta vinculada de la playa. 404 si nunca se vinculó. */
  async getAccount(tenantId: string): Promise<MpAccountDto> {
    const account = await this.requireAccount(tenantId);
    return toMpAccountDto(account);
  }

  /**
   * Arranca el flujo: crea el `state` de un solo uso con su `code_verifier` de
   * PKCE y devuelve la URL a la que mandar al dueño.
   *
   * El gate de dirección se chequea ACÁ y no sólo en el callback: mandar al
   * dueño a autorizar en Mercado Pago para después rebotarlo porque le falta la
   * calle es un viaje de ida y vuelta desperdiciado, y encima quema el
   * `authorization_code`.
   */
  async buildAuthorizationUrl(
    tenantId: string,
    user: User,
    dto: CreateMpAuthorizationUrlDto,
  ): Promise<MpAuthorizationUrlDto> {
    const tenant = await this.requireTenant(tenantId);
    this.assertAddressComplete(tenant, TENANT_INSTANCE);

    // Re-vincular una cuenta SANA obligaría a decidir qué hacer con el Store y
    // el POS que ya existen en Mercado Pago. Se corta acá y se pide desvincular
    // primero, que es explícito y reversible. Una cuenta en `token_expired` o
    // `revoked` SÍ puede re-vincularse: para eso `link()` hace upsert.
    const existing = await this.prisma.mpAccount.findUnique({
      where: { tenantId },
    });
    if (existing && existing.status === MpAccountStatus.linked) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        `Entity ${tenantId} already has an active Mercado Pago account linked. Unlink it before linking again.`,
        TENANT_INSTANCE,
        ErrorCodes.MP_ALREADY_LINKED,
      );
    }

    const returnPath = this.validateReturnPath(dto.returnPath);

    const state = randomUUID();
    const codeVerifier = base64Url(randomBytes(CODE_VERIFIER_BYTES));
    const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);

    await this.prisma.mpOauthState.create({
      data: {
        state,
        tenantId,
        userId: user.id,
        codeVerifier,
        returnPath,
        expiresAt,
      },
    });

    const url = new URL(MP_AUTHORIZATION_URL);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('platform_id', 'mp');
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', this.config.oauthRedirectUri);
    // PKCE S256: a Mercado Pago viaja sólo el HASH del verifier. Un `code`
    // interceptado sin el verifier original no se puede canjear.
    url.searchParams.set(
      'code_challenge',
      base64Url(createHash('sha256').update(codeVerifier).digest()),
    );
    url.searchParams.set('code_challenge_method', 'S256');
    // 🔴 SIN parámetro `scope`: Mercado Pago NO lo usa en este flujo y mandarlo
    // hace que rechace la autorización. Verificado contra la documentación
    // oficial del flujo `authorization_code`.

    return {
      authorizationUrl: url.toString(),
      state,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Cierra el flujo: canjea el `state`, valida quién vuelve, canjea el `code`
   * por tokens, provisiona Store + POS y persiste todo.
   *
   * ## Validaciones del `state`, y por qué todas devuelven LO MISMO
   *
   * En orden: (1) existe, (2) no consumido, (3) no vencido, (4) el `user_id`
   * coincide con quien llama, (5) quien llama sigue siendo `owner` de esa
   * playa. Los cinco fallos devuelven `MP_OAUTH_STATE_INVALID` con el MISMO
   * mensaje genérico, a propósito: distinguir "no existe" de "ya se usó" de "es
   * de otro usuario" le regala a un atacante un oráculo para enumerar states
   * ajenos y saber en qué estado están. Para el dueño legítimo la acción es la
   * misma en los cinco casos —volver a arrancar la vinculación— así que el
   * detalle no le suma nada.
   */
  async handleCallback(
    code: string,
    state: string,
    user: User,
  ): Promise<MpOauthCallbackResultDto> {
    const claimed = await this.claimState(state, user.id);

    try {
      // (5) El membership se re-chequea ACÁ y no se confía en el del inicio del
      // flujo: entre el `/authorize` y el callback pueden pasar 10 minutos, y en
      // el medio a esta persona la pudieron bajar de `owner` a `operator` o
      // sacar de la playa. `canManageEntity` es la única fuente de esa regla
      // (admin global incluido).
      const membership = await this.prisma.userMembership.findUnique({
        where: {
          userId_tenantId: { userId: user.id, tenantId: claimed.tenantId },
        },
      });
      if (!this.permissions.canManageEntity(user, membership)) {
        throw this.stateInvalid();
      }

      const tenant = await this.requireTenant(claimed.tenantId);
      this.assertAddressComplete(tenant, CALLBACK_INSTANCE);

      const tokens = await this.mpApi.exchangeAuthorizationCode(
        code,
        claimed.codeVerifier,
      );
      const { storeId, pos, externalPosId } = await this.provision(
        tokens.accessToken,
        tokens.mpUserId,
        tenant,
      );

      const account = await this.link(tenant.id, {
        mpUserId: tokens.mpUserId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        storeId,
        posId: pos.id,
        externalPosId: pos.externalId ?? externalPosId,
        qrImageUrl: pos.qrImageUrl,
        qrTemplateDocumentUrl: pos.qrTemplateDocumentUrl,
      });

      await this.audit.record({
        action: AuditActions.MP_ACCOUNT_LINKED,
        entityType: 'mp_account',
        entityId: account.id,
        actorUserId: user.id,
        tenantId: tenant.id,
        metadata: {
          mpUserId: account.mpUserId,
          storeId: account.storeId,
          posId: account.posId,
        },
      });

      return {
        account: toMpAccountDto(account),
        returnPath: claimed.returnPath,
      };
    } catch (error) {
      // El `state` ya se consumió, así que este intento está perdido: se audita
      // para que el dueño (y nosotros) veamos POR QUÉ falló sin tener que ir a
      // buscar el log del request.
      //
      // El `.catch()` NO es decorativo: si la escritura del audit falla, su
      // error reemplazaría al original y el cliente recibiría un 500 genérico
      // en lugar del 502/422 que explica qué pasó de verdad. El diagnóstico
      // real siempre gana; el audit es best-effort.
      await this.audit
        .record({
          action: AuditActions.MP_ACCOUNT_LINK_FAILED,
          entityType: 'mp_account',
          actorUserId: user.id,
          tenantId: claimed.tenantId,
          severity: 'warn',
          metadata: { reason: describeFailure(error) },
        })
        .catch((auditError: unknown) => {
          this.logger.error(
            `Could not audit the failed Mercado Pago link for tenant ${claimed.tenantId}`,
            auditError instanceof Error ? auditError.message : 'unknown error',
          );
        });
      throw error;
    }
  }

  /**
   * Desvincula la cuenta: deshabilita el método de pago y marca la fila.
   *
   * El método de pago se DESHABILITA, nunca se borra. Es `isSystem = true`, y
   * borrarlo se llevaría puesta la integridad histórica: hay
   * `payment_transactions` viejas que lo referencian, y el arqueo de caja de un
   * turno cerrado tiene que seguir mostrando cómo se cobró. Mismo criterio que
   * `EntitiesService.deletePaymentMethod`, que directamente prohíbe borrar los
   * métodos de sistema (`PAYMENT_METHOD_SYSTEM_LOCKED`).
   */
  async unlink(tenantId: string, user: User): Promise<void> {
    const account = await this.requireAccount(tenantId);

    // PUNTO DE EXTENSIÓN (B4): cuando exista `payment_intents`, acá va el
    // chequeo de intents abiertos de esta playa — desvincular con un cobro en
    // vuelo deja al cliente pagando contra un QR que ya no concilia con nadie.
    // Si los hay, el fallo es 409 `MP_UNLINK_BLOCKED_OPEN_INTENTS`.
    // No se escribe todavía: la tabla no existe y el code tampoco. Inventar
    // cualquiera de los dos acá sería código muerto que después nadie revisa.

    await this.prisma.$transaction(async (tx) => {
      await tx.mpAccount.update({
        where: { id: account.id },
        // `revoked` es el estado terminal que tiene el enum. Cubre las dos
        // formas de desvincular —desde este endpoint o desde la app de Mercado
        // Pago— porque el efecto es el mismo: los tokens dejan de servir y hay
        // que volver a autorizar. Agregar un valor `unlinked` sería una
        // migración de enum para una distinción que hoy nadie consume.
        data: { status: MpAccountStatus.revoked },
      });

      // `updateMany` y no `update`: filtra por `tenantId` (aislamiento manual)
      // y no explota si la playa no tiene el método —por ejemplo si la
      // vinculación es anterior a que se creara.
      await tx.paymentMethod.updateMany({
        where: { tenantId, type: PaymentMethodType.mercadopago_qr },
        data: { enabled: false, isDefault: false },
      });
    });

    await this.audit.record({
      action: AuditActions.MP_ACCOUNT_UNLINKED,
      entityType: 'mp_account',
      entityId: account.id,
      actorUserId: user.id,
      tenantId,
      metadata: { mpUserId: account.mpUserId },
    });
  }

  /**
   * Vuelve a pedirle a Mercado Pago los datos del POS y refresca las URLs del
   * QR. La fuente de verdad del QR es Mercado Pago, no nuestra copia: las URLs
   * son públicas y las puede regenerar.
   *
   * El token sale de `MpTokenService`, que es el único camino habilitado para
   * conseguir uno vivo. Antes esto hacía `assertOperational()` + `decrypt()` a
   * mano, y ese guard cortaba con 409 en cuanto el access token vencía por
   * reloj — o sea que una playa con el token vencido no podía ni reintentar el
   * resync, aunque su `refresh_token` siguiera sirviendo seis meses. Ahora ese
   * mismo caso renueva y el resync simplemente funciona.
   */
  async resyncPos(tenantId: string, user: User): Promise<MpAccountDto> {
    const { account, accessToken } =
      await this.tokens.getUsableAccessToken(tenantId);

    let storeId = account.storeId;
    let externalPosId = account.externalPosId;
    let pos: MpPos;

    if (account.posId) {
      pos = await this.mpApi.getPos(accessToken, account.posId);
    } else {
      // Sin POS no hay nada que releer: se provisiona. En el camino feliz esto
      // no pasa —las tres llamadas a Mercado Pago corren ANTES de escribir la
      // fila, así que nunca queda una cuenta a medio vincular— pero una fila
      // cargada a mano o una migración futura sí podría dejarla así, y el dueño
      // merece un botón que lo arregle sin re-autorizar.
      const tenant = await this.requireTenant(tenantId);
      const provisioned = await this.provision(
        accessToken,
        account.mpUserId,
        tenant,
      );
      storeId = provisioned.storeId;
      externalPosId = provisioned.externalPosId;
      pos = provisioned.pos;
    }

    const updated = await this.prisma.mpAccount.update({
      where: { id: account.id },
      data: {
        storeId,
        posId: pos.id,
        externalPosId: pos.externalId ?? externalPosId,
        qrImageUrl: pos.qrImageUrl,
        qrTemplateDocumentUrl: pos.qrTemplateDocumentUrl,
      },
    });

    this.logger.log(
      `Mercado Pago POS re-synced for tenant ${tenantId} (pos ${pos.id}) by user ${user.id}`,
    );

    return toMpAccountDto(updated);
  }

  /**
   * 🔴 EL CANJE DEL `state`, EN UNA SOLA SENTENCIA.
   *
   * Un `UPDATE ... WHERE state = $1 AND consumed_at IS NULL AND expires_at >
   * now() AND user_id = $2` es atómico por sí solo: Postgres toma el row lock,
   * evalúa el `WHERE` sobre la versión ya bloqueada y devuelve cuántas filas
   * tocó. Si devuelve 1, ESTE request ganó el canje; si devuelve 0, perdió.
   *
   * Partirlo en `SELECT` + `UPDATE` rompe exactamente eso: dos callbacks
   * simultáneos con el mismo `state` leen los dos `consumed_at IS NULL`, los dos
   * deciden que está libre, y los dos siguen. Resultado: dos vinculaciones
   * contra el mismo código, dos Store/POS en Mercado Pago, y una carrera por
   * ver cuál escribe último. No es teórico: un doble click en el botón del
   * panel, o el retry automático de un proxy, alcanza.
   *
   * El `user_id` va DENTRO del mismo `WHERE` (no como chequeo posterior) para
   * que un callback de otro usuario ni siquiera CONSUMA el state: si sólo se
   * validara después, cualquiera con el `state` podría quemarle la vinculación
   * al dueño legítimo aunque no llegue a completarla.
   *
   * El `findUnique` de después es sólo para leer `code_verifier`, `tenant_id` y
   * `return_path` de la fila que YA ganamos: nadie puede des-consumirla, así que
   * no hay carrera que valga.
   */
  private async claimState(
    state: string,
    userId: string,
  ): Promise<{
    tenantId: string;
    codeVerifier: string;
    returnPath: string | null;
  }> {
    const claimed = await this.prisma.mpOauthState.updateMany({
      where: {
        state,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        userId,
      },
      data: { consumedAt: new Date() },
    });

    if (claimed.count !== 1) {
      throw this.stateInvalid();
    }

    const row = await this.prisma.mpOauthState.findUnique({ where: { state } });
    if (!row) {
      // Inalcanzable salvo que alguien borre la fila entre las dos sentencias
      // (la purga de states vencidos de B2c no toca los recién consumidos).
      // Se trata igual que cualquier otro fallo de state.
      throw this.stateInvalid();
    }

    return {
      tenantId: row.tenantId,
      codeVerifier: row.codeVerifier,
      returnPath: row.returnPath,
    };
  }

  /**
   * Crea el Store y el POS de la playa en Mercado Pago. Devuelve todo lo que
   * hay que persistir, sin tocar la base: lo llaman tanto la vinculación como
   * el resync.
   */
  private async provision(
    accessToken: string,
    mpUserId: string,
    tenant: Tenant,
  ): Promise<{ storeId: string; pos: MpPos; externalPosId: string }> {
    const store = await this.mpApi.createStore(accessToken, mpUserId, {
      name: storeName(tenant),
      externalId: storeExternalId(tenant.id),
      location: this.requireStoreLocation(tenant),
    });

    const externalPosId = posExternalId(tenant.id);
    const pos = await this.mpApi.createPos(accessToken, {
      name: posName(tenant),
      storeId: store.id,
      externalId: externalPosId,
    });

    return { storeId: store.id, pos, externalPosId };
  }

  /**
   * 🔴 `upsert` sobre `tenant_id`, NO `create`.
   *
   * `mp_accounts.tenant_id` es UNIQUE. Con `create`, el dueño que re-corre el
   * OAuth porque su token venció se come un `P2002` —un 409 de base que nadie
   * sabe leer— en vez de volver a quedar vinculado. Re-vincular es un caso
   * NORMAL, no un error: el `refresh_token` vence, la app se puede revocar
   * desde Mercado Pago, y el camino de salida de `token_expired` es
   * exactamente éste.
   *
   * El `update` resetea `refreshFailureCount` y `lastRefreshAt`: los tokens son
   * NUEVOS, arrastrar el contador de fallos del par anterior haría que el cron
   * de B2c marque como vencida una cuenta recién vinculada.
   *
   * El método de pago `mercadopago_qr` se crea en la MISMA transacción. No lo
   * siembra `bootstrap_tenant_defaults()` —decisión ya tomada y escrita en
   * `payment-methods.prisma`— porque una playa sin Mercado Pago vinculado no
   * tiene por qué mostrar ese medio en la pantalla de cobro. Y no pasa por
   * `EntitiesService.createPaymentMethod`, que hardcodea `type: 'other'`.
   */
  private async link(
    tenantId: string,
    input: {
      mpUserId: string;
      accessToken: string;
      refreshToken: string;
      accessTokenExpiresAt: Date;
      storeId: string;
      posId: string;
      externalPosId: string;
      qrImageUrl: string | null;
      qrTemplateDocumentUrl: string | null;
    },
  ): Promise<MpAccount> {
    const access = this.crypto.encrypt(input.accessToken);
    const refresh = this.crypto.encrypt(input.refreshToken);
    const linkedAt = new Date();

    const persisted: Prisma.MpAccountUncheckedCreateInput = {
      tenantId,
      mpUserId: input.mpUserId,
      accessToken: access.ciphertext,
      refreshToken: refresh.ciphertext,
      // Los dos tokens se cifran en la misma pasada, con la clave ACTIVA, así
      // que comparten versión. La columna es una sola y esto lo deja explícito.
      tokenKeyVersion: access.keyVersion,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      status: MpAccountStatus.linked,
      storeId: input.storeId,
      posId: input.posId,
      externalPosId: input.externalPosId,
      qrImageUrl: input.qrImageUrl,
      qrTemplateDocumentUrl: input.qrTemplateDocumentUrl,
      refreshFailureCount: 0,
      lastRefreshAt: null,
      linkedAt,
    };

    return this.prisma.$transaction(async (tx) => {
      const account = await tx.mpAccount.upsert({
        where: { tenantId },
        create: persisted,
        update: persisted,
      });

      await this.ensurePaymentMethod(tx, tenantId);

      return account;
    });
  }

  /**
   * Deja listo el método de pago `mercadopago_qr` de la playa.
   *
   * No hay unique `(tenant_id, type)` que permita un `upsert` de Prisma: la
   * unicidad de los métodos de sistema es un índice PARCIAL en SQL
   * (`payment_methods_tenant_system_type_idx WHERE is_system = true`), que
   * Prisma no sabe expresar. De ahí el find + create/update.
   *
   * En el re-link sólo se re-habilita: NO se pisa el `name`. Los métodos de
   * sistema son renombrables por el dueño (así nacen "Efectivo" y
   * "Transferencia"), y volver a vincular no es motivo para deshacerle el
   * nombre que eligió.
   */
  private async ensurePaymentMethod(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<void> {
    const existing = await tx.paymentMethod.findFirst({
      where: { tenantId, type: PaymentMethodType.mercadopago_qr },
    });

    if (existing) {
      await tx.paymentMethod.update({
        where: { id: existing.id },
        data: { enabled: true },
      });
      return;
    }

    await tx.paymentMethod.create({
      data: {
        tenantId,
        type: PaymentMethodType.mercadopago_qr,
        name: MP_PAYMENT_METHOD_NAME,
        isSystem: true,
      },
    });
  }

  /** La cuenta de ESTA playa, filtrando a mano por `tenantId`. */
  private async requireAccount(tenantId: string): Promise<MpAccount> {
    const account = await this.prisma.mpAccount.findUnique({
      where: { tenantId },
    });
    if (!account) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Entity ${tenantId} has no Mercado Pago account linked`,
        TENANT_INSTANCE,
        ErrorCodes.MP_NOT_LINKED,
      );
    }
    return account;
  }

  private async requireTenant(tenantId: string): Promise<Tenant> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });
    if (!tenant) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Entity ${tenantId} not found`,
        TENANT_INSTANCE,
        ErrorCodes.ENTITY_NOT_FOUND,
      );
    }
    return tenant;
  }

  /**
   * Gate de dirección. Se REUSA `missingDeclaredAddressFields`
   * (`src/entities/tenant-address.ts`), que es el mismo criterio del wizard de
   * onboarding y del front: sus cuatro campos obligatorios son exactamente los
   * que Mercado Pago pide para `Store.location` (`street_name`,
   * `street_number`, `city_name`, `state_name`). Escribir otro chequeo acá
   * garantizaría que los dos se desincronicen.
   */
  private assertAddressComplete(tenant: Tenant, instance: string): void {
    const missing = missingDeclaredAddressFields(toEntityAddressDto(tenant));
    if (missing.length === 0) return;

    throw new FormattedException(
      'Unprocessable Entity',
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Entity ${tenant.id} is missing ${describeMissingAddressFields(missing)}. Mercado Pago requires a complete structured address for the store location.`,
      instance,
      ErrorCodes.MP_ENTITY_ADDRESS_INCOMPLETE,
    );
  }

  /**
   * Estrecha las cuatro columnas a `string` para armar el payload del Store.
   *
   * `assertAddressComplete` ya corrió, pero tiene un atajo: si Georef normalizó
   * la dirección (`geocoding_source = 'georef'` con línea de display), da por
   * completa la dirección sin mirar las columnas. Una fila así —vieja, o
   * escrita por un camino que no llenó las columnas— pasaría el gate y llegaría
   * acá con nulls. Se trata como el MISMO 422: la dirección no sirve para el
   * Store, que es para lo que se pide.
   */
  private requireStoreLocation(tenant: Tenant): MpStoreLocation {
    const { streetName, streetNumber, cityName, stateName } = tenant;
    if (!streetName || !streetNumber || !cityName || !stateName) {
      throw new FormattedException(
        'Unprocessable Entity',
        HttpStatus.UNPROCESSABLE_ENTITY,
        `Entity ${tenant.id} has no structured street/city/state columns. Mercado Pago requires them for the store location.`,
        TENANT_INSTANCE,
        ErrorCodes.MP_ENTITY_ADDRESS_INCOMPLETE,
      );
    }

    const latitude = decimalToNumber(tenant.latitude);
    const longitude = decimalToNumber(tenant.longitude);

    return {
      streetName,
      streetNumber,
      cityName,
      stateName,
      // El par va completo o no va: la base ya lo exige
      // (`tenants_coordinates_paired`) y media coordenada le pone el local en
      // el medio del océano al mapa de Mercado Pago.
      ...(latitude !== null && longitude !== null
        ? { latitude, longitude }
        : {}),
    };
  }

  /**
   * Valida el `returnPath` ANTES de guardarlo. Ver `isSafeReturnPath` para el
   * porqué de cada regla: sin esto, el callback es un open redirect con nuestro
   * dominio adelante.
   *
   * El code es `VALIDATION_FAILED`, el mismo que habría puesto el
   * `ValidationPipe` con el `@Matches` del DTO: es la misma falla —un campo del
   * body mal formado— y darle un code propio obligaría a los tres frontends a
   * traducir dos cosas idénticas.
   */
  private validateReturnPath(returnPath?: string): string | null {
    if (returnPath === undefined) return null;

    if (!isSafeReturnPath(returnPath)) {
      throw new FormattedException(
        'Bad Request',
        HttpStatus.BAD_REQUEST,
        'returnPath must be an internal path starting with a single "/" (no scheme, no host, no backslashes)',
        TENANT_INSTANCE,
        ErrorCodes.VALIDATION_FAILED,
      );
    }
    return returnPath;
  }

  /** El ÚNICO error de `state`. Mismo texto para los cinco casos, a propósito. */
  private stateInvalid(): FormattedException {
    return new FormattedException(
      'Bad Request',
      HttpStatus.BAD_REQUEST,
      'The Mercado Pago OAuth state is invalid, expired, already used, or does not belong to the caller.',
      CALLBACK_INSTANCE,
      ErrorCodes.MP_OAUTH_STATE_INVALID,
    );
  }
}

/** base64url sin padding, como pide RFC 7636 para PKCE. */
function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/**
 * `external_id` del Store: nuestro identificador del lado de Mercado Pago.
 * Determinístico a partir del `tenantId` para que re-provisionar apunte
 * siempre a la misma sucursal. Tope de MP: 60 caracteres alfanuméricos.
 */
function storeExternalId(tenantId: string): string {
  return `PARKITSTORE${tenantId.replace(/-/g, '').toUpperCase()}`;
}

/** Ídem para el POS. Tope de MP: 40 caracteres. */
function posExternalId(tenantId: string): string {
  return `PARKITPOS${tenantId.replace(/-/g, '').toUpperCase()}`.slice(
    0,
    MAX_POS_EXTERNAL_ID_LENGTH,
  );
}

/**
 * Nombre de la sucursal. Mercado Pago NO documenta un tope para el `name` del
 * Store (sí para el del POS), así que se reusa el del POS como cota
 * conservadora: mandar un string sin límite a una API que no dice cuánto acepta
 * es cómo se descubre el límite en producción.
 */
function storeName(tenant: Tenant): string {
  return tenant.name.trim().slice(0, MAX_POS_NAME_LENGTH) || 'Parkit';
}

/**
 * Mercado Pago sólo acepta alfanuméricos, guiones, guiones bajos y espacios
 * internos en el `name` del POS, con tope de 45 caracteres. Una playa llamada
 * "Estacionamiento Perón & Cía." reventaría el alta, así que se sanea.
 */
function posName(tenant: Tenant): string {
  const cleaned = tenant.name
    .replace(POS_NAME_ALLOWED, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_POS_NAME_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : 'Parkit POS';
}

/** `Prisma.Decimal | number | null` → `number | null`, sin romper con null. */
function decimalToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Resumen del fallo para el audit log. Sólo el `code` del ProblemDetails —que
 * es estable y no lleva datos— o el nombre del error. NUNCA el mensaje crudo:
 * podría arrastrar un fragmento de respuesta de Mercado Pago.
 */
function describeFailure(error: unknown): string {
  if (error instanceof FormattedException) {
    const body: unknown = error.getResponse();
    if (body !== null && typeof body === 'object' && 'code' in body) {
      const code: unknown = (body as Record<string, unknown>).code;
      if (typeof code === 'string') return code;
    }
  }
  return error instanceof Error ? error.name : 'UnknownError';
}
