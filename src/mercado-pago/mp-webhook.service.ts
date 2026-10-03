import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PaymentIntentStatus } from '@prisma/client';
import type { PaymentIntent } from '@prisma/client';
import { AuditActions, AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import {
  RESERVATION_PAYMENT_GATEWAY,
  type ProviderPayment,
  type ReservationPaymentGateway,
} from '../reservations/payment-gateway/reservation-payment-gateway';
import { ReservationLifecycleService } from '../reservations/reservation-lifecycle.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { MpApiClient, type MpOrder } from './mp-api.client';
import { MpSignatureService } from './mp-signature.service';
import { MpTokenService } from './mp-token.service';

/** Ruta lógica para el `instance` de los ProblemDetails de este endpoint. */
const INSTANCE = '/integrations/mercadopago/webhook';

/**
 * El único tópico que nos interesa. Mercado Pago manda muchos más (`payment`,
 * `merchant_order`, `point_integration_wh`, ...) por la misma URL si alguien
 * los habilita en el panel, y todos tienen que terminar en un 200 silencioso.
 */
const ORDER_TOPIC = 'order';

/** Pagos de Checkout Pro (reservas): el estado sale de leer el pago. */
const PAYMENT_TOPIC = 'payment';

/** Contracargos: fuera del MVP, se acusa recibo y se loguea. */
const CHARGEBACK_TOPICS: readonly string[] = [
  'topic_chargebacks_wh',
  'chargebacks',
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Los `code` con los que `MpApiClient` avisa que Mercado Pago no responde. */
const MP_DOWN_CODES: readonly string[] = [
  ErrorCodes.MP_UNAVAILABLE,
  ErrorCodes.MP_UNREACHABLE,
];

/**
 * Los `status` de una `Order` de Mercado Pago. Son STRINGS y no un enum de
 * Prisma a propósito: es el vocabulario de un tercero, y un valor nuevo de su
 * lado no puede romper el parseo del nuestro.
 */
const MpOrderStatus = {
  CREATED: 'created',
  PROCESSED: 'processed',
  CANCELED: 'canceled',
  REFUNDED: 'refunded',
  EXPIRED: 'expired',
} as const;

/**
 * Una notificación tal como llega al controller: headers, el `data.id` de la
 * query y el cuerpo CRUDO.
 */
export interface MpWebhookNotification {
  /** Header `x-signature` (`ts=<ts>,v1=<hash>`). */
  readonly signatureHeader?: string | null;
  /** Header `x-request-id`. Entra al manifest firmado si viene. */
  readonly requestId?: string | null;
  /**
   * `data.id` de la QUERY STRING. 🔴 Es el ÚNICO dato del evento que la firma
   * autentica, así que es el que manda para buscar la orden — el del cuerpo es
   * sólo un fallback para cuando Mercado Pago no lo pone en la query.
   */
  readonly dataId?: string | null;
  /** El cuerpo sin tocar: un `Buffer` del parser raw de `main.ts`. */
  readonly rawBody?: unknown;
  /**
   * Query `type` / `topic` / `id`. Mercado Pago pone `?type=payment&data.id=`
   * en las notificaciones firmadas y `?topic=payment&id=` en las IPN viejas
   * (sin firma). El tópico del cuerpo gana cuando está.
   */
  readonly queryType?: string | null;
  readonly queryTopic?: string | null;
  readonly queryId?: string | null;
  /** Reloj inyectable, para testear la ventana de replay. */
  readonly now?: Date;
}

/**
 * El webhook de Mercado Pago: la notificación de que algo le pasó a una
 * `Order`.
 *
 * ## 🔴 El cuerpo NO ESTÁ FIRMADO. Esto es un DISPARADOR, no una fuente de
 * ## verdad
 *
 * El manifest que firma Mercado Pago es, literalmente:
 *
 * ```
 * id:{data.id};request-id:{x-request-id};ts:{ts};
 * ```
 *
 * O sea: tres escalares de headers y query. **El cuerpo entero queda afuera**,
 * y con él el campo `action`, que es el que uno tendría la tentación de usar
 * para decidir. La consecuencia es concreta y no teórica: dentro de la ventana
 * de replay de ±5 minutos, cualquiera que capture una notificación legítima
 * puede reenviarla con `action: "order.processed"` y **la firma sigue
 * validando**. Decidir por el cuerpo sería marcar aprobado un intento que nadie
 * pagó — estacionamiento gratis, y con un rastro de auditoría que dice que se
 * cobró.
 *
 * Por eso, para CUALQUIER acción que mueva plata, el estado sale de una lectura
 * fresca a Mercado Pago (`GET /v1/orders/{id}`) y NUNCA del cuerpo. Es UNA
 * llamada saliente, muy por debajo del timeout de 22 s con el que Mercado Pago
 * corta la notificación, y es además lo que recomienda su propia documentación:
 * tratar el webhook como aviso y resolver leyendo el recurso.
 *
 * Corolario práctico: `action` y `type` se leen sólo para DESCARTAR barato
 * (tópicos que no son nuestros). Nunca para aprobar, cancelar ni reembolsar.
 *
 * ## Contrato de respuesta: un solo 4xx
 *
 * | Situación                                            | Respuesta |
 * | ---------------------------------------------------- | --------- |
 * | Firma inválida o `ts` fuera de la ventana de replay   | **401**   |
 * | Tópico desconocido, acción desconocida, cuerpo ilegible | 200 vacío |
 * | Orden que no es nuestra / intent inexistente          | 200 vacío |
 * | Transición aplicada, o ya la había aplicado otro      | 200 vacío |
 * | No pudimos releer la orden en Mercado Pago            | **503**   |
 *
 * El 200 es el default y no una concesión: Mercado Pago interpreta cualquier
 * cosa que no sea 2xx como "no lo recibieron" y **reintenta cada 15 minutos**.
 * Un 500 ante algo inesperado —un tópico nuevo, un `action` que no conocemos—
 * es una cola de reintentos infinita por un evento que ya decidimos ignorar, y
 * además rompe el check de calidad `webhooks_ipn` de la homologación.
 *
 * El 503 es la única excepción, y es deliberada: si no pudimos confirmar el
 * estado real contra Mercado Pago, un 200 sería dar por procesado un pago que
 * nadie verificó. Ahí SÍ queremos el reintento.
 *
 * ## Por qué no hay tenant en el contexto
 *
 * Mercado Pago llega sin JWT de Supabase, sin `:tenantId` en la ruta y sin nada
 * en el `AsyncLocalStorage`. `PaymentIntent` no está en `TENANT_MODELS`
 * justamente por esto (ver la cabecera de
 * `prisma/schema/global/payment-intents.prisma`), así que acá se usa el cliente
 * Prisma PLANO y la playa se DEDUCE de la fila encontrada: el `tenantId` sale
 * de `intent.tenantId` y de ningún otro lado.
 */
@Injectable()
export class MpWebhookService {
  private readonly logger = new Logger(MpWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly signatures: MpSignatureService,
    private readonly tokens: MpTokenService,
    private readonly mpApi: MpApiClient,
    private readonly audit: AuditService,
    @Inject(RESERVATION_PAYMENT_GATEWAY)
    private readonly gateway: ReservationPaymentGateway,
    private readonly lifecycle: ReservationLifecycleService,
  ) {}

  /**
   * Procesa una notificación. Resolver = 200 vacío; tirar = el status de la
   * excepción.
   *
   * El orden de los pasos es el diseño: primero la firma (antes de tocar la
   * base), después el descarte barato por tópico, después la fila, y recién
   * ahí la llamada saliente a Mercado Pago.
   */
  async handle(notification: MpWebhookNotification): Promise<void> {
    // ── 0. IPN legacy ─────────────────────────────────────────────────────
    //
    // El formato viejo (`?topic=payment&id=123`) no viene firmado y no hay
    // forma de autenticarlo: se acusa recibo (un 401 sólo generaría reintentos)
    // y se ignora. Los pagos nos llegan por el webhook firmado.
    if (
      !str(notification.signatureHeader) &&
      !str(notification.dataId) &&
      (str(notification.queryTopic) || str(notification.queryId))
    ) {
      this.logger.debug(
        `Ignoring a legacy unsigned IPN (topic "${str(notification.queryTopic) ?? 'unknown'}")`,
      );
      return;
    }

    // ── 1. Firma ──────────────────────────────────────────────────────────
    //
    // Va PRIMERO y antes de cualquier query: si no está firmada, esto es
    // tráfico anónimo de internet y no puede costar ni un `SELECT`.
    const valid = this.signatures.isValid({
      signatureHeader: notification.signatureHeader,
      requestId: notification.requestId,
      dataId: notification.dataId,
      now: notification.now,
    });

    if (!valid) {
      this.logger.warn(
        'Rejected a Mercado Pago notification with an invalid or replayed signature',
      );
      // Code genérico `UNAUTHORIZED` a propósito: el único que recibe este
      // cuerpo es Mercado Pago, que lo ignora, y ningún frontend lo traduce.
      // Sumar un code al catálogo para algo que nadie lee sería ruido.
      throw new FormattedException(
        'Unauthorized',
        HttpStatus.UNAUTHORIZED,
        'The Mercado Pago notification signature is missing, invalid, or outside the replay window.',
        INSTANCE,
        ErrorCodes.UNAUTHORIZED,
      );
    }

    // ── 2. El cuerpo, leído a mano y campo por campo ──────────────────────
    const queryTopic =
      str(notification.queryType) ?? str(notification.queryTopic);
    // Con el tópico en la query el cuerpo es opcional (el `payment` firmado se
    // resuelve por `data.id`); sin tópico en ningún lado, un cuerpo ilegible no
    // tiene de dónde sacar nada.
    const payload = parseBody(notification.rawBody) ?? (queryTopic ? {} : null);
    if (!payload) {
      this.logger.warn(
        'A signed Mercado Pago notification arrived with an unreadable body: ignoring it',
      );
      return;
    }

    const type = str(payload.type) ?? str(payload.topic) ?? queryTopic;
    const action = str(payload.action);
    const bodyDataId = str(obj(payload.data)?.id);

    // ── 3. Tópico ─────────────────────────────────────────────────────────
    if (type === PAYMENT_TOPIC) {
      await this.handlePayment(
        str(notification.dataId) ?? bodyDataId,
        str(payload.user_id) ??
          (typeof payload.user_id === 'number'
            ? String(payload.user_id)
            : null),
        type,
      );
      return;
    }

    if (type && CHARGEBACK_TOPICS.includes(type)) {
      this.logger.log(
        `Acknowledging Mercado Pago chargeback notification "${type}" (out of scope for now)`,
      );
      return;
    }

    if (type !== ORDER_TOPIC) {
      this.logger.log(
        `Ignoring Mercado Pago notification of topic "${type ?? 'unknown'}" (action "${action ?? 'none'}")`,
      );
      return;
    }

    // El de la query gana: es el único que la firma cubre. El del cuerpo es el
    // fallback para las integraciones donde MP no lo pone en la query.
    const orderId = str(notification.dataId) ?? bodyDataId;
    if (!orderId) {
      this.logger.warn(
        'A Mercado Pago order notification arrived without data.id: ignoring it',
      );
      return;
    }

    // ── 4. La fila ────────────────────────────────────────────────────────
    //
    // `findFirst` y no `findUnique`: el índice único de `mp_order_id` es
    // PARCIAL (`WHERE mp_order_id IS NOT NULL`) y Prisma no sabe expresarlo,
    // así que el campo no figura como `@unique` en el schema.
    const intent = await this.prisma.paymentIntent.findFirst({
      where: { mpOrderId: orderId },
    });

    // ── 5. No es nuestra, o todavía no la conocemos ───────────────────────
    //
    // Dos casos distintos y los dos terminan en 200. El segundo importa: un
    // intento cuyo `POST /v1/orders` murió por timeout quedó en `created` SIN
    // `mp_order_id`, así que esta búsqueda no lo encuentra aunque la orden
    // exista y esté paga. Ese hueco lo cierra el reconciliador (tanda 3b)
    // re-POSTeando con la misma `X-Idempotency-Key`; el webhook no puede, y
    // devolver un error acá sólo agregaría reintentos inútiles.
    if (!intent) {
      this.logger.warn(
        `Mercado Pago notified about order ${orderId} (action "${action ?? 'none'}") but no payment intent references it`,
      );
      return;
    }

    // ── 6. El estado REAL, leído de Mercado Pago ──────────────────────────
    const order = await this.readOrder(intent, orderId);

    // ── 7. La transición ──────────────────────────────────────────────────
    await this.applyOrderStatus(intent, order);
  }

  /**
   * Un pago de Checkout Pro. Igual que con las órdenes, la notificación es un
   * DISPARADOR: el estado sale de leer el pago en Mercado Pago, con el token de
   * la playa, y nunca del cuerpo.
   *
   * Pasos: (1) deducir la playa, (2) leer el pago, (3) ubicar la reserva por
   * `external_reference` entre las de esa playa, (4) despachar al ciclo de vida
   * (idempotente: un aviso repetido o fuera de orden es inofensivo).
   *
   * Errores: Mercado Pago caído -> 503 (que reintente). Una vez identificado
   * como pago de una reserva, cualquier fallo INESPERADO del despacho (p. ej.
   * la base caída en `markPaid`) también -> 503, para que Mercado Pago
   * reintente: el ciclo de vida es idempotente. Token vencido / cuenta
   * desvinculada, o un 4xx esperado del ciclo de vida (409 de estado, 404), y
   * cualquier fallo ANTES de identificar la reserva -> 200 con un warn: el
   * barrido de reservas recupera el pago aprobado que se haya perdido.
   */
  private async handlePayment(
    paymentId: string | null,
    userId: string | null,
    topic: string,
  ): Promise<void> {
    if (!paymentId) {
      this.logger.warn(
        'A Mercado Pago payment notification arrived without data.id: ignoring it',
      );
      return;
    }

    const tenantIds = await this.resolveTenants(paymentId, userId);
    if (tenantIds.length === 0) {
      this.logger.debug(
        `Mercado Pago payment ${paymentId} (topic ${topic}) does not belong to any linked entity: ignoring it`,
      );
      return;
    }

    let reservationId: string | null = null;
    let identified = false;
    try {
      const payment = await this.gateway.getPayment({
        tenantId: tenantIds[0],
        providerPaymentId: paymentId,
      });

      reservationId = payment.externalReference;
      const match =
        reservationId && UUID_RE.test(reservationId)
          ? await this.prisma.reservationPayment.findFirst({
              where: { reservationId, tenantId: { in: tenantIds } },
              select: { reservationId: true, tenantId: true },
            })
          : null;
      if (!match) {
        this.logger.debug(
          `Mercado Pago payment ${paymentId} (topic ${topic}) is not a reservation payment: ignoring it`,
        );
        return;
      }

      identified = true;
      await this.applyPayment(
        match.reservationId,
        payment,
        topic,
        match.tenantId,
      );
    } catch (error) {
      const code = failureCode(error);
      if (code && MP_DOWN_CODES.includes(code)) {
        this.logger.error(
          `Mercado Pago is unavailable while handling payment ${paymentId} (reservation ${reservationId ?? 'unknown'}, topic ${topic}): ${describeFailure(error)}`,
        );
        throw new FormattedException(
          'Service Unavailable',
          HttpStatus.SERVICE_UNAVAILABLE,
          `Could not verify Mercado Pago payment ${paymentId}. Retry later.`,
          INSTANCE,
          ErrorCodes.MP_UNAVAILABLE,
        );
      }
      if (identified && isUnexpectedFailure(error, code)) {
        this.logger.error(
          `Unexpected failure applying Mercado Pago payment ${paymentId} (reservation ${reservationId ?? 'unknown'}, topic ${topic}): ${describeFailure(error)}. Answering 503 so Mercado Pago retries`,
        );
        throw new FormattedException(
          'Service Unavailable',
          HttpStatus.SERVICE_UNAVAILABLE,
          `Could not apply Mercado Pago payment ${paymentId}. Retry later.`,
          INSTANCE,
          ErrorCodes.MP_WEBHOOK_PAYMENT_UNVERIFIED,
        );
      }
      this.logger.warn(
        `Could not apply Mercado Pago payment ${paymentId} (reservation ${reservationId ?? 'unknown'}, topic ${topic}): ${describeFailure(error)}`,
      );
    }
  }

  /**
   * La playa dueña del pago: primero por un pago ya conocido
   * (`providerPaymentId`) y, si es el primer aviso, por el `user_id` del
   * vendedor contra las cuentas vinculadas. Más de una cuenta puede compartir
   * `mpUserId` (no es único), por eso devuelve una lista.
   */
  private async resolveTenants(
    paymentId: string,
    userId: string | null,
  ): Promise<string[]> {
    const known = await this.prisma.reservationPayment.findFirst({
      where: { providerPaymentId: paymentId },
      select: { tenantId: true },
    });
    if (known) return [known.tenantId];
    if (!userId) return [];

    const accounts = await this.prisma.mpAccount.findMany({
      where: { mpUserId: userId, status: 'linked' },
      select: { tenantId: true },
    });
    return accounts.map((account) => account.tenantId);
  }

  /** Despacha el estado leído del pago al ciclo de vida de la reserva. */
  private async applyPayment(
    reservationId: string,
    payment: ProviderPayment,
    topic: string,
    tenantId: string,
  ): Promise<void> {
    const ref = {
      providerPaymentId: payment.providerPaymentId,
      providerStatusDetail: payment.statusDetail,
    };
    const context = `payment ${payment.providerPaymentId}, reservation ${reservationId}, entity ${tenantId}, topic ${topic}`;

    switch (payment.status) {
      case 'approved': {
        const result = await this.lifecycle.markPaid(reservationId, {
          ...ref,
          providerStatus: 'approved',
        });
        this.logger.log(
          `Mercado Pago ${context}: approved -> ${result.outcome}`,
        );
        return;
      }
      case 'partially_refunded': {
        // Un pago devuelto a medias estuvo aprobado: si todavía no lo
        // habíamos anotado, se confirma primero (idempotente).
        await this.lifecycle.markPaid(reservationId, {
          ...ref,
          providerStatus: 'approved',
        });
        const result = await this.lifecycle.confirmRefund(reservationId, {
          refundedAmountArs: payment.refundedAmountArs,
          providerPaymentId: payment.providerPaymentId,
        });
        this.logger.log(
          `Mercado Pago ${context}: partially refunded -> ${result.outcome}`,
        );
        return;
      }
      case 'refunded': {
        const result = await this.lifecycle.confirmRefund(reservationId, {
          refundedAmountArs: payment.refundedAmountArs || payment.amountArs,
          providerPaymentId: payment.providerPaymentId,
        });
        this.logger.log(
          `Mercado Pago ${context}: refunded -> ${result.outcome}`,
        );
        return;
      }
      case 'rejected':
        await this.lifecycle.markPaymentRejected(reservationId, {
          ...ref,
          providerStatus: 'rejected',
        });
        this.logger.log(`Mercado Pago ${context}: rejected`);
        return;
      default:
        this.logger.log(
          `Mercado Pago ${context} is "${payment.status}": nothing to do`,
        );
    }
  }

  /**
   * Relee la orden en Mercado Pago con el token de la playa dueña del intento.
   *
   * Cualquier fallo de acá —cuenta desvinculada, token vencido, MP caído,
   * timeout— se traduce a un 503 ÚNICO. Dos motivos:
   *
   *  1. El contrato del endpoint dice que el 401 de firma es el único 4xx. El
   *     `getUsableAccessToken` de una cuenta rota tira 404/409, y esos status
   *     le dirían a Mercado Pago algo sobre el request que no es cierto: el
   *     request está perfecto, el roto es nuestro lado.
   *  2. Un 5xx es lo único que hace que Mercado Pago reintente, y acá el
   *     reintento es lo que queremos: si el dueño re-vincula la cuenta, la
   *     notificación que viene después sí se va a poder procesar.
   *
   * Lo que NO se hace es tragarse el error con un 200: sería dar por procesada
   * una notificación de pago que nadie verificó.
   */
  private async readOrder(
    intent: PaymentIntent,
    orderId: string,
  ): Promise<MpOrder> {
    try {
      const { accessToken } = await this.tokens.getUsableAccessToken(
        intent.tenantId,
      );
      return await this.mpApi.getOrder(accessToken, orderId);
    } catch (error) {
      this.logger.error(
        `Could not verify Mercado Pago order ${orderId} of entity ${intent.tenantId} ` +
          `before applying its notification: ${describeFailure(error)}`,
      );
      throw new FormattedException(
        'Service Unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
        `Could not verify Mercado Pago order ${orderId} before applying the notification. Retry later.`,
        INSTANCE,
        ErrorCodes.MP_WEBHOOK_ORDER_UNVERIFIED,
      );
    }
  }

  /**
   * Traduce el `status` REAL de la orden a una transición de nuestro intento.
   *
   * Toda transición es un `updateMany` con guarda `WHERE status IN (...)`,
   * igual que en `PaymentIntentsService`: la base resuelve la carrera y
   * **`count === 0` significa "ya lo manejó otro", que NO es un error**. El
   * webhook, el poller del desktop, el botón de cancelar y el reconciliador
   * corren en paralelo sobre la misma fila.
   *
   * | `status` de MP | intent        | guarda                          |
   * | -------------- | ------------- | ------------------------------- |
   * | `processed`    | `approved`    | `created`, `pending`, `expired` |
   * | `canceled`     | `canceled`    | `created`, `pending`            |
   * | `expired`      | `expired`     | `created`, `pending`            |
   * | `refunded`     | `refunded`    | `approved`, `consumed`          |
   *
   * ## 🔴 `expired` está en la guarda de APROBACIÓN y no es un error de tipeo
   *
   * Nuestro `expired` lo escribe la expiración perezosa de `getById` con
   * NUESTRO reloj; el `processed` de Mercado Pago es un HECHO sobre plata que
   * ya se movió. La carrera es real y ordinaria: marcamos `expired` a los 5:00,
   * el cliente había pagado a las 4:59, la notificación llega a las 5:02. Si
   * `expired` fuera terminal, **perdemos el pago**: la estadía cierra como
   * impaga, el cliente pagó igual, y esa plata queda huérfana sin que nadie la
   * reclame. Es el peor resultado posible del sistema. **La plata le gana a
   * nuestro reloj.**
   *
   * La asimetría es deliberada: aceptamos `processed` viniendo de `expired`,
   * pero NUNCA des-expiramos por cuenta propia (un `canceled` o un `expired`
   * de MP no resucitan nada).
   *
   * ## Acción/estado desconocido → 200 y a otra cosa
   *
   * Las acciones documentadas para Código QR son cuatro (`order.processed`,
   * `order.canceled`, `order.refunded`, `order.expired`) y las de Point son
   * seis (suman `order.action_required` y `order.failed`). Como decidimos por
   * el `status` leído y no por el nombre de la acción, la diferencia casi no
   * importa — pero cualquier valor que no reconozcamos se loguea y se contesta
   * 200. El `created` de MP entra acá a propósito: es una orden recién creada
   * que todavía no se pagó, y no hay nada que mover.
   */
  private async applyOrderStatus(
    intent: PaymentIntent,
    order: MpOrder,
  ): Promise<void> {
    switch (order.status) {
      case MpOrderStatus.PROCESSED:
        await this.transition(
          intent,
          order,
          PaymentIntentStatus.approved,
          [
            PaymentIntentStatus.created,
            PaymentIntentStatus.pending,
            PaymentIntentStatus.expired,
          ],
          // `approved_at` sale del reloj de Mercado Pago cuando lo manda: entre
          // el pago y esta notificación pueden haber pasado minutos, y el
          // comprobante tiene que decir cuándo se pagó, no cuándo nos
          // enteramos.
          { approvedAt: order.lastUpdatedDate ?? new Date() },
        );
        return;

      case MpOrderStatus.CANCELED:
        await this.transition(intent, order, PaymentIntentStatus.canceled, [
          PaymentIntentStatus.created,
          PaymentIntentStatus.pending,
        ]);
        return;

      case MpOrderStatus.EXPIRED:
        await this.transition(intent, order, PaymentIntentStatus.expired, [
          PaymentIntentStatus.created,
          PaymentIntentStatus.pending,
        ]);
        return;

      case MpOrderStatus.REFUNDED:
        await this.refund(intent, order);
        return;

      default:
        this.logger.log(
          `Mercado Pago order ${order.id} is "${order.status ?? 'unknown'}": nothing to do for payment intent ${intent.id}`,
        );
    }
  }

  /**
   * Un contracargo/devolución: la plata se fue para atrás.
   *
   * Sólo aplica desde `approved` o `consumed` — un intento que nunca se pagó no
   * se puede reembolsar—, y **se audita siempre que la transición gane**, no
   * sólo cuando es grave, porque es el único evento de este webhook en el que
   * la playa pierde plata que ya había contado.
   *
   * La severidad distingue los dos casos, que son muy distintos:
   *
   *  - desde `consumed` → `crit`. El intento YA generó su `PaymentTransaction`
   *    y el arqueo del turno contó esa plata: la caja de ese turno ahora está
   *    mal y hay que corregirla a mano. Alguien tiene que mirarlo hoy.
   *  - desde `approved` → `warn`. Todavía no se había consumido, así que no
   *    ensució ningún arqueo; simplemente ese pago ya no existe.
   *
   * ⚠️ El enum `AuditSeverity` es `info | warn | crit`. NO existe `error`.
   */
  private async refund(intent: PaymentIntent, order: MpOrder): Promise<void> {
    const count = await this.transition(
      intent,
      order,
      PaymentIntentStatus.refunded,
      [PaymentIntentStatus.approved, PaymentIntentStatus.consumed],
    );

    if (count === 0) return;

    const alreadyCounted = intent.status === PaymentIntentStatus.consumed;

    await this.audit.record({
      action: AuditActions.PAYMENT_INTENT_REFUNDED,
      entityType: 'payment_intent',
      entityId: intent.id,
      // Sin `actorUserId`: no hay persona nuestra atrás de un webhook.
      tenantId: intent.tenantId,
      severity: alreadyCounted ? 'crit' : 'warn',
      metadata: {
        mpOrderId: order.id,
        previousStatus: intent.status,
        mpStatusDetail: order.statusDetail,
      },
    });
  }

  /**
   * El `updateMany` guardado, con el par de estados crudos de Mercado Pago
   * pegados a la misma escritura.
   *
   * Devuelve el `count` para que quien llama pueda distinguir "lo moví yo" de
   * "ya estaba movido" — que es lo que decide si hay que auditar. Un `count`
   * en 0 NO se loguea como error: es el caso normal de una notificación
   * repetida (Mercado Pago reintenta) o de una carrera con el poller.
   *
   * El `WHERE` lleva `tenantId` además del `id` por costumbre defensiva: el
   * `id` ya es la PK, pero esta tabla se filtra a mano SIEMPRE (no está en
   * `TENANT_MODELS`) y la costumbre es lo que evita que la próxima query nazca
   * sin el filtro.
   */
  private async transition(
    intent: PaymentIntent,
    order: MpOrder,
    next: PaymentIntentStatus,
    from: readonly PaymentIntentStatus[],
    extra: Record<string, unknown> = {},
  ): Promise<number> {
    const { count } = await this.prisma.paymentIntent.updateMany({
      where: {
        id: intent.id,
        tenantId: intent.tenantId,
        status: { in: [...from] },
      },
      data: {
        status: next,
        mpStatus: order.status,
        mpStatusDetail: order.statusDetail,
        ...extra,
      },
    });

    this.logger.log(
      count === 0
        ? `Payment intent ${intent.id} was already handled by somebody else (Mercado Pago order ${order.id} is "${order.status ?? 'unknown'}")`
        : `Payment intent ${intent.id} moved to ${next} from Mercado Pago order ${order.id}`,
    );

    return count;
  }
}

/**
 * Lee el cuerpo crudo y lo convierte en un objeto, o devuelve `null`.
 *
 * ## 🔴 Acá NO hay DTO, y no es pereza
 *
 * `main.ts` configura el `ValidationPipe` global con `forbidNonWhitelisted:
 * true`. Si este cuerpo se tipara con un DTO, el día que Mercado Pago agregue
 * un campo nuevo —cosa que hace— el endpoint contestaría **400**, Mercado Pago
 * lo leería como fallo de entrega y **reintentaría cada 15 minutos para
 * siempre**; y de paso se cae el check de calidad `webhooks_ipn` de la
 * homologación. Por eso: `JSON.parse` a mano y lectura defensiva campo por
 * campo.
 *
 * ⚠️ El motivo NO es la firma. El manifest son sólo escalares de headers y
 * query (`id`, `request-id`, `ts`), así que acá no hace falta el cuerpo byte a
 * byte como sí hace falta en otras pasarelas. Queda escrito para que nadie
 * "optimice" esto reemplazándolo por un DTO creyendo que sólo se trataba de
 * preservar bytes para el HMAC.
 *
 * Acepta también un objeto ya parseado: el parser raw de `main.ts` se registra
 * antes que el de Nest, pero un endpoint de cobro no puede dejar de funcionar
 * porque alguien reordene dos líneas del bootstrap.
 */
function parseBody(raw: unknown): Record<string, unknown> | null {
  if (Buffer.isBuffer(raw)) return parseJson(raw.toString('utf8'));
  if (typeof raw === 'string') return parseJson(raw);
  return obj(raw);
}

function parseJson(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  try {
    return obj(JSON.parse(text));
  } catch {
    return null;
  }
}

/** String no vacío, o `null`. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** Objeto plano, o `null` (un array no es un objeto útil acá). */
function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Resumen del fallo para el log: el `code` estable del ProblemDetails cuando
 * lo hay, y nunca el mensaje crudo, que puede arrastrar un pedazo de la
 * respuesta de Mercado Pago.
 */
function describeFailure(error: unknown): string {
  if (error instanceof FormattedException) {
    const body: unknown = error.getResponse();
    if (body !== null && typeof body === 'object' && 'code' in body) {
      return `${String((body as Record<string, unknown>).code)} (HTTP ${error.getStatus()})`;
    }
    return `HTTP ${error.getStatus()}`;
  }
  return error instanceof Error ? error.name : 'unknown error';
}

/**
 * ¿Es un fallo que justifica pedir reintento? Los errores de token de la cuenta
 * y los 4xx esperados del ciclo de vida (409 de estado, 404) NO: reintentar
 * daría lo mismo. Todo lo demás (base caída, bug, 5xx) sí.
 */
function isUnexpectedFailure(error: unknown, code: string | null): boolean {
  if (
    code === ErrorCodes.MP_ACCOUNT_TOKEN_EXPIRED ||
    code === ErrorCodes.MP_ACCOUNT_REVOKED ||
    code === ErrorCodes.MP_NOT_LINKED
  ) {
    return false;
  }
  if (error instanceof HttpException) return error.getStatus() >= 500;
  return true;
}

/** El `code` estable de un `FormattedException`, o `null`. */
function failureCode(error: unknown): string | null {
  if (!(error instanceof FormattedException)) return null;
  const body: unknown = error.getResponse();
  return body !== null && typeof body === 'object' && 'code' in body
    ? String((body as Record<string, unknown>).code)
    : null;
}
