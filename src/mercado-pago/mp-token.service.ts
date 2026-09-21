import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { MpAccountStatus, PaymentMethodType } from '@prisma/client';
import type { MpAccount, Prisma } from '@prisma/client';
import { AuditActions, AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { MpApiClient, type MpOauthTokens } from './mp-api.client';
import { MpCryptoService } from './mp-crypto.service';

/**
 * Margen con el que se renueva: si al access token le quedan menos de 30 días,
 * esta llamada lo renueva antes de devolverlo.
 *
 * El número sale de los plazos de Mercado Pago, no de la intuición: el access
 * token dura 180 días y el `refresh_token` 6 meses. 30 días de colchón
 * significa que, desde el primer intento fallido, quedan ~30 días de llamadas
 * exitosas con el token viejo para que la renovación prenda en algún request
 * posterior. Es lo que hace que un incidente de Mercado Pago de horas —o de
 * días— no se traduzca en una playa sin cobrar.
 *
 * Bajarlo (1 día, 1 hora) borra ese colchón y ata la salud del token a que
 * Mercado Pago esté vivo en esa ventana exacta. Subirlo mucho hace que casi
 * todo request caiga en la rama de renovación y le suma un round-trip a cada
 * cobro sin comprar nada.
 */
const REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Fallos CONSECUTIVOS de refresh antes de degradar la cuenta. Es el mismo 3
 * que documenta `prisma/schema/global/mercado-pago.prisma` en
 * `refresh_failure_count`.
 */
const MAX_REFRESH_FAILURES = 3;

/**
 * Instance de los ProblemDetails. Es el MISMO valor que usaba
 * `MpAccountsService.assertOperational`, y se mantiene a propósito: los errores
 * de este service reemplazan a los de aquel guard en el endpoint de resync, y
 * cambiar el `instance` sería romper el contrato de una respuesta que ya está
 * publicada por una cuestión cosmética.
 */
const INSTANCE = '/tenants/:tenantId/mercado-pago';

/** Lo que necesita quien va a hablar con Mercado Pago: la fila y el token. */
export interface MpUsableAccessToken {
  /**
   * La fila YA ACTUALIZADA si hubo renovación. Se devuelve junto al token
   * porque el que cobra necesita además `posId` / `mpUserId` de la misma fila,
   * y volver a leerla abriría una ventana para usar un `posId` viejo.
   */
  readonly account: MpAccount;
  /** El access token EN PLANO. Nunca se loguea ni se audita. */
  readonly accessToken: string;
}

/**
 * Entrega un access token de Mercado Pago vivo, y gestiona la salud de ese
 * token como efecto del uso.
 *
 * ## 🔴 Este es el ÚNICO camino por el que cualquier código puede hablar con
 * Mercado Pago usando el token del vendedor
 *
 * Nadie más descifra `mp_accounts.access_token`. Si aparece un
 * `crypto.decrypt(account.accessToken, ...)` fuera de acá, eso es un bug: ese
 * camino se saltea el refresh perezoso, se saltea la degradación, y va a
 * explotar con un 502 el día que el token esté vencido.
 *
 * ## Por qué es un service propio y no un método de `MpAccountsService`
 *
 * Son dos responsabilidades distintas. `MpAccountsService` gestiona el FLUJO DE
 * VINCULACIÓN (OAuth, PKCE, alta del Store/POS, permisos del dueño) y ya pasa
 * las 700 líneas. Esto otro es el ciclo de vida del token, y lo van a consumir
 * los payment intents y el webhook — que no tienen por qué arrastrar una
 * dependencia al service de OAuth para pedir un token.
 *
 * La dirección de la dependencia es `MpAccountsService → MpTokenService`, nunca
 * al revés: acá adentro no se sabe nada de OAuth, de Store ni de POS.
 *
 * ## El refresh es PEREZOSO, en el punto de uso. NO hay cron
 *
 * El plan original tenía un `@Cron(EVERY_6_HOURS)` que barría las cuentas por
 * vencer. Se canceló, y conviene dejar escrito por qué para que no vuelva:
 *
 *  1. **El advisory lock que lo justificaba sobraba.** El diseño del cron
 *     necesitaba `pg_try_advisory_lock` para que dos instancias no refrescaran
 *     la misma cuenta a la vez. Pero la documentación oficial de Mercado Pago
 *     (es/MLA) dice que el `refresh_token` **"puede ser reutilizado"**: dos
 *     refreshes concurrentes NO se invalidan entre sí.
 *  2. **`pg_try_advisory_lock` es incompatible con el pool de Prisma.** El lock
 *     es POR SESIÓN, o sea por conexión. Con un pool, el `unlock` sale por una
 *     conexión distinta de la que tomó el lock y no libera nada: el lock queda
 *     colgado hasta que esa conexión muera. **No es opción acá. No lo
 *     "mejores" agregándolo.**
 *  3. **Un `@Cron` in-process en Cloud Run exige `min-instances=1`.** Sin
 *     instancia viva no hay timer, así que la salud de los tokens quedaría
 *     atada a una decisión de infraestructura que se puede revisar por costos.
 *
 * ## Concurrencia: NO hay lock, y es deliberado
 *
 * Dos cobros simultáneos sobre una cuenta por vencer disparan dos refreshes.
 * Es inofensivo, por el punto (1) de arriba: el `refresh_token` es reutilizable,
 * los dos canjes devuelven pares válidos, y el último `UPDATE` gana. El peor
 * caso es una llamada de más a Mercado Pago cada 150 días.
 *
 * Serializar eso costaría un lock distribuido —que no tenemos— o el advisory
 * lock del punto (2) —que no funciona—. Se paga una llamada de más y se
 * termina el problema.
 *
 * ## El access token vencido NO es terminal
 *
 * `MpAccountsService.assertOperational` cortaba con 409 cuando
 * `accessTokenExpiresAt <= now()`. Con refresh perezoso eso era un BUG: el
 * `refresh_token` dura 6 meses y recupera solo un access token vencido. Ese
 * guard mataba un caso perfectamente recuperable, así que el vencimiento por
 * reloj acá **no corta: manda a renovar**.
 *
 * Lo terminal es otra cosa: que el refresh FALLE con el token ya vencido, o que
 * falle 3 veces seguidas. Recién ahí la cuenta pasa a `token_expired` y el
 * medio de pago se apaga.
 */
@Injectable()
export class MpTokenService {
  private readonly logger = new Logger(MpTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: MpCryptoService,
    private readonly mpApi: MpApiClient,
  ) {}

  /**
   * El access token vivo de una playa, renovándolo si hace falta.
   *
   * Orden de las decisiones, que importa:
   *
   *  1. Sin cuenta → 404. Nunca se vinculó.
   *  2. `revoked` → 409, **sin tocar Mercado Pago**: el dueño le sacó el
   *     permiso a la aplicación, así que el `refresh_token` tampoco sirve y
   *     pedirle uno nuevo es un round-trip garantizado a un rechazo.
   *  3. `token_expired` → 409. Ya está degradada; sale de ahí re-autorizando
   *     desde el botón "Re-vincular", no reintentando.
   *  4. Más de 30 días de margen → se descifra y se devuelve el que hay. **Cero
   *     llamadas a Mercado Pago**, que es el camino del 99% de los cobros.
   *  5. Menos de 30 días, vencido incluido → se renueva.
   *
   * 🔴 Aislamiento multi-tenant MANUAL: `mp_accounts` no está en
   * `TENANT_MODELS`, así que el `WHERE tenant_id` lo pone esta query a mano.
   * Ver el docblock de `MpAccountsService`.
   */
  async getUsableAccessToken(tenantId: string): Promise<MpUsableAccessToken> {
    const account = await this.prisma.mpAccount.findUnique({
      where: { tenantId },
    });

    if (!account) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Entity ${tenantId} has no Mercado Pago account linked`,
        INSTANCE,
        ErrorCodes.MP_NOT_LINKED,
      );
    }

    if (account.status === MpAccountStatus.revoked) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        `Mercado Pago account of entity ${tenantId} was revoked. Link it again.`,
        INSTANCE,
        ErrorCodes.MP_ACCOUNT_REVOKED,
      );
    }

    if (account.status === MpAccountStatus.token_expired) {
      throw this.tokenExpired(tenantId);
    }

    const msLeft = account.accessTokenExpiresAt.getTime() - Date.now();
    if (msLeft > REFRESH_WINDOW_MS) {
      return { account, accessToken: this.decryptAccessToken(account) };
    }

    return this.refresh(account);
  }

  /**
   * Canjea el `refresh_token` por un par nuevo y lo persiste.
   *
   * El descifrado del `refresh_token` va ANTES del `try`: si falla, es un
   * problema de claves nuestro (`MP_TOKEN_DECRYPT_FAILED`, 500) y no un fallo
   * de Mercado Pago. Meterlo adentro lo contaría como fallo de refresh e iría
   * degradando la cuenta por un error de configuración que arreglar la clave
   * resuelve.
   */
  private async refresh(account: MpAccount): Promise<MpUsableAccessToken> {
    const refreshToken = this.crypto.decrypt(
      account.refreshToken,
      account.tokenKeyVersion,
    );

    let tokens: MpOauthTokens;
    try {
      tokens = await this.mpApi.refreshAccessToken(refreshToken);
    } catch (error) {
      return this.handleRefreshFailure(account, error);
    }

    // Los dos se cifran con la clave ACTIVA (`encrypt` no acepta otra), así que
    // comparten versión y una sola columna `tokenKeyVersion` alcanza. Renovar
    // es además lo que re-cifra la fila con la clave nueva después de una
    // rotación, sin necesidad de un script de migración.
    const access = this.crypto.encrypt(tokens.accessToken);
    const refresh = this.crypto.encrypt(tokens.refreshToken);

    // Un solo `UPDATE` de una sola fila: Postgres ya lo aplica de forma
    // atómica, así que envolverlo en `$transaction` no compraría nada. Lo que
    // NO puede pasar es persistir el access token nuevo sin su refresh token
    // nuevo, y eso está cubierto porque van en la misma sentencia.
    const updated = await this.prisma.mpAccount.update({
      where: { id: account.id },
      data: {
        accessToken: access.ciphertext,
        refreshToken: refresh.ciphertext,
        tokenKeyVersion: access.keyVersion,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        // Contador de fallos CONSECUTIVOS: un éxito lo vuelve a cero, si no
        // tres hipos espaciados en meses terminarían degradando una cuenta sana.
        refreshFailureCount: 0,
        lastRefreshAt: new Date(),
      },
    });

    this.logger.log(
      `Mercado Pago access token refreshed for tenant ${account.tenantId} ` +
        `(expires ${tokens.accessTokenExpiresAt.toISOString()})`,
    );

    await this.recordAudit({
      action: AuditActions.MP_ACCOUNT_TOKEN_REFRESHED,
      account,
      severity: 'info',
      metadata: {
        expiresAt: tokens.accessTokenExpiresAt.toISOString(),
        keyVersion: access.keyVersion,
      },
    });

    return { account: updated, accessToken: tokens.accessToken };
  }

  /**
   * 🔴 Un 500 de Mercado Pago NO puede dejar a una playa sin cobrar.
   *
   * Por eso el fallo de refresh **no propaga el error** mientras el access token
   * actual siga vigente: se anota el fallo y se devuelve el token que hay, que
   * funciona. El contador está justamente para distinguir un hipo de Mercado
   * Pago de una muerte real del vínculo, y hay hasta 30 días de colchón para
   * que algún request posterior consiga renovar. Este criterio ya está escrito
   * en `prisma/schema/global/mercado-pago.prisma` (`refresh_failure_count`).
   *
   * Se degrada en dos casos, y son distintos:
   *
   *  - **3 fallos consecutivos**: el vínculo está roto de verdad, no es un
   *    incidente pasajero.
   *  - **El access token ya venció por reloj**: no hay colchón que gastar. El
   *    token que devolveríamos no sirve, así que seguir "tolerando" el fallo
   *    sólo cambiaría un 409 accionable ("re-vinculá") por un 502 críptico en
   *    la pantalla de cobro. Se degrada al primer fallo.
   */
  private async handleRefreshFailure(
    account: MpAccount,
    error: unknown,
  ): Promise<MpUsableAccessToken> {
    // `{ increment: 1 }` y no `count + 1` calculado en JS: dos cobros que
    // fallan a la vez leerían el mismo valor y escribirían el mismo número,
    // perdiendo uno de los dos fallos. Que lo sume Postgres es gratis y no
    // tiene esa carrera.
    const failed = await this.prisma.mpAccount.update({
      where: { id: account.id },
      data: { refreshFailureCount: { increment: 1 } },
    });

    const expired = account.accessTokenExpiresAt.getTime() <= Date.now();
    const reason = describeFailure(error);

    // `>=` y no `===`: si una fila quedó con el contador por encima del umbral
    // —una edición a mano, un despliegue que bajó el máximo— un `===` no
    // degradaría NUNCA y la cuenta se quedaría rota en silencio.
    if (failed.refreshFailureCount >= MAX_REFRESH_FAILURES || expired) {
      await this.degrade(failed, { reason, expired });
      throw this.tokenExpired(account.tenantId);
    }

    this.logger.warn(
      `Mercado Pago token refresh failed for tenant ${account.tenantId} ` +
        `(${reason}, failure ${failed.refreshFailureCount}/${MAX_REFRESH_FAILURES}). ` +
        'Serving the current access token, which is still valid.',
    );

    return { account: failed, accessToken: this.decryptAccessToken(account) };
  }

  /**
   * Marca la cuenta como `token_expired` y APAGA el medio de pago.
   *
   * Apagar el medio de pago es la mitad que importa: sin eso, el operario
   * seguiría viendo "Mercado Pago QR" en la pantalla de cobro, lo elegiría, y
   * se comería un 502 incomprensible delante del cliente. Con el medio apagado
   * la opción directamente no aparece y el cobro sigue por otro camino.
   *
   * Las dos escrituras van en UNA transacción: una cuenta degradada con el
   * medio de pago prendido es exactamente el estado que esto viene a evitar.
   *
   * El método se DESHABILITA, nunca se borra —mismo criterio que `unlink()`—:
   * es `isSystem = true` y hay `payment_transactions` históricas que lo
   * referencian. `updateMany` y no `update` porque filtra a mano por
   * `tenantId` (aislamiento manual) y no explota si la playa no tiene el
   * método.
   */
  private async degrade(
    account: MpAccount,
    metadata: { reason: string; expired: boolean },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.mpAccount.update({
        where: { id: account.id },
        data: { status: MpAccountStatus.token_expired },
      });

      await tx.paymentMethod.updateMany({
        where: {
          tenantId: account.tenantId,
          type: PaymentMethodType.mercadopago_qr,
        },
        data: { enabled: false, isDefault: false },
      });
    });

    this.logger.error(
      `Mercado Pago account of tenant ${account.tenantId} degraded to ` +
        `token_expired (${metadata.reason}, ${failuresLabel(account, metadata.expired)}). ` +
        'The payment method was disabled; the owner must authorize again.',
    );

    await this.recordAudit({
      action: AuditActions.MP_ACCOUNT_TOKEN_EXPIRED,
      account,
      // `crit` y no `warn`: la playa perdió un medio de cobro y no se recupera
      // sola, hace falta que una persona entre al panel y re-vincule. Es el
      // evento que tiene que saltar en el tablero de auditoría.
      severity: 'crit',
      metadata: {
        reason: metadata.reason,
        expiredAccessToken: metadata.expired,
        failureCount: account.refreshFailureCount,
      },
    });
  }

  /**
   * El audit es BEST-EFFORT, igual que en `MpAccountsService.handleCallback`.
   *
   * Si la escritura falla, su error reemplazaría al resultado real: en el
   * camino exitoso convertiría una renovación que SÍ funcionó en un 500, y en
   * el de degradación taparía el 409 accionable con un 500 genérico. El
   * resultado real siempre gana.
   */
  private async recordAudit(input: {
    action: string;
    account: MpAccount;
    severity: 'info' | 'crit';
    metadata: Prisma.InputJsonValue;
  }): Promise<void> {
    await this.audit
      .record({
        action: input.action,
        entityType: 'mp_account',
        entityId: input.account.id,
        // Sin `actorUserId` a propósito: la renovación no es una acción de
        // quien disparó el request, es una consecuencia de la edad del token.
        // Atribuírsela al operario que estaba cobrando ensuciaría el rastro de
        // auditoría con algo que esa persona no hizo.
        tenantId: input.account.tenantId,
        severity: input.severity,
        metadata: input.metadata,
      })
      .catch((auditError: unknown) => {
        this.logger.error(
          `Could not audit ${input.action} for tenant ${input.account.tenantId}`,
          auditError instanceof Error ? auditError.message : 'unknown error',
        );
      });
  }

  private decryptAccessToken(account: MpAccount): string {
    return this.crypto.decrypt(account.accessToken, account.tokenKeyVersion);
  }

  private tokenExpired(tenantId: string): FormattedException {
    return new FormattedException(
      'Conflict',
      HttpStatus.CONFLICT,
      `Mercado Pago access token of entity ${tenantId} expired. The owner must authorize again.`,
      INSTANCE,
      ErrorCodes.MP_ACCOUNT_TOKEN_EXPIRED,
    );
  }
}

/**
 * Resume el fallo para el audit y el log. Devuelve el `code` del
 * ProblemDetails cuando lo hay —`MP_UNAVAILABLE` dice bastante más que
 * "FormattedException"— y nunca el mensaje completo, que puede arrastrar el
 * cuerpo de la respuesta de Mercado Pago.
 *
 * Es la misma función que `MpAccountsService`, duplicada a propósito: moverla a
 * un `mp-errors.ts` compartido por dos usos es un archivo más para ahorrar diez
 * líneas, y acopla dos services que hoy no se conocen.
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

/** Por qué se degradó, para el log: el contador o el reloj. */
function failuresLabel(account: MpAccount, expired: boolean): string {
  return expired
    ? 'access token already expired'
    : `${account.refreshFailureCount} consecutive failures`;
}
