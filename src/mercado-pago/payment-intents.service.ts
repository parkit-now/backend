import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PaymentIntentStatus, Prisma } from '@prisma/client';
import type { PaymentIntent, User } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AuditActions, AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import {
  CreatePaymentIntentDto,
  PaymentIntentDto,
} from './dto/payment-intent.dto';
import { toPaymentIntentDto } from './mercado-pago.mappers';
import { MpApiClient, type MpOrder, type MpOrderInput } from './mp-api.client';
import { MpTokenService } from './mp-token.service';

/**
 * Cuánto vive un intento de cobro, en minutos.
 *
 * Cinco es un número de mostrador, no de ingeniería: es lo que tarda un cliente
 * en sacar el teléfono, abrir la app y escanear un cartel, con margen para el
 * que no encuentra la app. Más largo traba la caja al pedo cuando alguien se
 * arrepiente (ver `payment_intents_tenant_live_idx`); más corto hace que el
 * cliente lento se coma un QR vencido y haya que rehacer el cobro.
 *
 * De acá salen LAS DOS formas del vencimiento, y por eso hay una sola
 * constante: nuestro `expires_at` (instante absoluto, para la base) y el
 * `expiration_time` que viaja a Mercado Pago (duración relativa ISO 8601).
 * Si se desincronizaran, MP y nosotros discreparíamos sobre si la orden sigue
 * viva, que es exactamente el estado en el que nadie sabe si se puede cobrar.
 */
const INTENT_TTL_MINUTES = 5;

/** El TTL como milisegundos, para calcular `expires_at`. */
const INTENT_TTL_MS = INTENT_TTL_MINUTES * 60 * 1000;

/**
 * El TTL como duración ISO 8601, que es lo que `POST /v1/orders` espera en
 * `expiration_time`. DURACIÓN relativa y no instante: ver el docblock de
 * `MpOrderInput`, un instante absoluto cambiaría en cada re-POST y rompería la
 * recuperación idempotente.
 */
const MP_EXPIRATION_TIME = `PT${INTENT_TTL_MINUTES}M`;

/**
 * 🔴 La descripción que ve el cliente en la app de Mercado Pago. GENÉRICA Y
 * FIJA, y no se "mejora" nunca.
 *
 * La versión natural sería `Estadía ABC123`, con la patente. LA PATENTE ES UN
 * DATO PERSONAL y Mercado Pago prohíbe explícitamente mandar PII en este campo
 * (ver el docblock de `MpOrderInput.description`). Tampoco el nombre del
 * cliente, ni el documento, ni la cochera. Si hace falta identificar el cobro
 * ya está `external_reference`, que es el UUID del intento: opaco y para eso
 * existe.
 *
 * Que sea FIJA tiene un segundo motivo, independiente del anterior: entra al
 * body que se re-POSTea con la misma `X-Idempotency-Key`. Un texto que dependa
 * de la fila cambiaría entre reintentos y devolvería
 * `409 idempotency_key_already_used` en vez de la orden original.
 */
const ORDER_DESCRIPTION = 'Estadía de estacionamiento';

/** Título del único ítem de la orden. Mismo criterio que `ORDER_DESCRIPTION`. */
const ORDER_ITEM_TITLE = 'Estadía de estacionamiento';

/** `unit_measure` de Mercado Pago: obligatorio y con tope de 10 caracteres. */
const ORDER_ITEM_UNIT_MEASURE = 'unit';

/**
 * Los estados que el índice `payment_intents_tenant_live_idx` considera vivos:
 * la orden existe (o puede existir) del lado de Mercado Pago y el QR de la caja
 * está comprometido. `approved` queda AFUERA a propósito — con el pago ya
 * acreditado la caja quedó libre; ver la migración 20260921030000.
 *
 * Es además el conjunto exacto que puede vencer: sólo tiene sentido barrer por
 * reloj lo que todavía está esperando a alguien.
 */
const OPEN_STATUSES: readonly PaymentIntentStatus[] = [
  PaymentIntentStatus.created,
  PaymentIntentStatus.pending,
];

/** Instance de los ProblemDetails de la colección. */
const COLLECTION_INSTANCE = '/tenants/:tenantId/payment-intents';

/** Instance de los ProblemDetails de un intento puntual. */
const ITEM_INSTANCE = '/tenants/:tenantId/payment-intents/:paymentIntentId';

/**
 * Los intentos de cobro con QR de Mercado Pago: alta, consulta, cancelación y
 * el listado de pagos huérfanos.
 *
 * ## 🔴 Regla transversal de la máquina de estados: TODA transición es un
 * ## `updateMany` con guarda `WHERE status IN (...)`
 *
 * No hay `UPDATE` de estado sin guarda en este archivo, y no es estilo: es TODA
 * la estrategia de concurrencia de la tabla, que a propósito no tiene columna
 * `version` (el porqué está en la cabecera de
 * `prisma/schema/global/payment-intents.prisma`).
 *
 * El contrato es: el `WHERE` incluye los estados DESDE los que la transición es
 * legal, la base resuelve la carrera, y el `count` del resultado dice quién
 * ganó. **`count === 0` significa "ya lo manejó otro" y NO es un error.** Es el
 * caso normal, no el excepcional: el webhook de Mercado Pago, el reconciliador,
 * el poller del desktop y el botón de cancelar corren en paralelo sobre la
 * misma fila y llegan cuando llegan. Tratar el 0 como fallo convertiría la
 * operación normal en un 500 intermitente e imposible de reproducir.
 *
 * Dos corolarios que hay que tener presentes al agregar código acá:
 *
 *  1. NUNCA se lee el estado, se decide en memoria y se escribe después. Entre
 *     el `SELECT` y el `UPDATE` hay una ventana, y el webhook vive justo ahí.
 *     La decisión va DENTRO del `WHERE`.
 *  2. Cuando el `count` da 0 y hay que devolver la fila, se RELEE. Devolver lo
 *     que se había leído antes sería contarle al desktop un estado que ya no
 *     existe.
 *
 * ## 🔴 Aislamiento multi-tenant MANUAL
 *
 * `PaymentIntent` vive en `prisma/schema/global/` y NO está en `TENANT_MODELS`
 * (`src/database/prisma-tenant.ts`), así que la extensión de Prisma NO inyecta
 * el `WHERE tenant_id`. Mismo caso que `MpAccount` en `MpAccountsService` y que
 * `PaymentMethod` en `EntitiesService`.
 *
 * Consecuencia práctica, y no hay red abajo —la tabla es backend-only, con RLS
 * prendida y sin policies—: **cada query de este service filtra a mano por el
 * `:tenantId` de la ruta**, que el `TenantMembershipGuard` ya validó. Olvidarse
 * de ese filtro en UNA query es una fuga entre playas. `Entry` sí está en
 * `TENANT_MODELS`, pero acá se usa el cliente SIN scopear (el mismo `prisma` de
 * siempre, no `getTenantClient()`), así que tampoco tiene red: se filtra igual,
 * a mano.
 *
 * Hay UNA sola query en todo el archivo cuyo `WHERE` no lleva `tenantId`, está
 * marcada y explicada en `create`.
 *
 * ## Qué NO está acá, a propósito
 *
 * El webhook de Mercado Pago y el reconciliador por cron. Los dos son
 * cross-tenant (llegan sin `:tenantId`) y los dos escriben esta misma tabla,
 * así que van a necesitar sus propias transiciones guardadas — pero con otro
 * ciclo de vida y otra superficie de ataque. Este service es el lado HTTP, el
 * que tiene un operario autenticado del otro lado.
 */
@Injectable()
export class PaymentIntentsService {
  private readonly logger = new Logger(PaymentIntentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    // 🔴 El ÚNICO camino permitido para conseguir un access token. Este service
    // no descifra nada por su cuenta: hacerlo se saltearía el refresh perezoso
    // y la degradación de la cuenta, y la playa dejaría de cobrar sin que nadie
    // se entere.
    private readonly tokens: MpTokenService,
    private readonly mpApi: MpApiClient,
  ) {}

  /**
   * Crea el intento y su `Order` en Mercado Pago.
   *
   * ## El orden de los pasos ES el diseño
   *
   * 1. Si ya existe un intento con ese `id`, se devuelve TAL CUAL y no se toca
   *    nada más. Esa es la idempotencia del endpoint: el `id` lo genera el
   *    desktop (UUIDv7), así que un reintento después de un timeout trae el
   *    mismo y no crea una segunda orden.
   * 2. La estadía tiene que existir, ser de esta playa y seguir abierta.
   * 3. Se barren por reloj los intentos vencidos de la playa (ver
   *    `expireStaleIntents`). Sin esto, uno viejo bloquea el alta por el índice
   *    único parcial y el reintento legítimo es imposible.
   * 4. El token, que de paso valida que la cuenta esté operativa.
   * 5. Sin `external_pos_id` no hay caja contra la cual cobrar.
   * 6. 🔴 LA FILA SE PERSISTE **ANTES** DE LLAMAR A MERCADO PAGO, y esto es
   *    deliberado. Si `POST /v1/orders` muere por timeout NO SABEMOS si la
   *    orden existe del otro lado: el estado `created` marca exactamente esa
   *    incertidumbre, y la fila persistida es lo único que permite después
   *    re-POSTear con la misma key y averiguarlo. Al revés —llamar primero y
   *    persistir después— el timeout deja una orden viva en la caja de la que
   *    no queda ni rastro nuestro, y esa caja se traba hasta que MP la venza.
   * 7. La llamada a MP.
   * 8. Éxito: se guarda el `mp_order_id` y se pasa a `pending`.
   * 9. Fallo: la fila queda en `failed` con el motivo, y el error se propaga.
   */
  async create(
    tenantId: string,
    user: User,
    dto: CreatePaymentIntentDto,
  ): Promise<PaymentIntentDto> {
    // ── 1. Idempotencia por `id` del cliente ──────────────────────────────
    //
    // ⚠️ ÉSTA es la única query del archivo cuyo `WHERE` no lleva `tenantId`, y
    // tiene que ser así: la pregunta es "¿este `id` YA ESTÁ USADO?", y el `id`
    // es la PRIMARY KEY, global por definición. Buscarlo scopeado por playa
    // contestaría "no existe" para un id de otra playa y el INSERT de abajo
    // explotaría igual, pero con un P2002 sobre la PK que no dice nada útil.
    //
    // El aislamiento se sostiene en la línea siguiente: si la fila es de otra
    // playa, no se devuelve NADA de ella — ni el estado, ni el monto, ni la
    // estadía. Sólo que el id está tomado, que es lo mismo que sabría quien lo
    // generó.
    const existing = await this.prisma.paymentIntent.findUnique({
      where: { id: dto.id },
    });

    if (existing) {
      if (existing.tenantId !== tenantId) {
        throw new FormattedException(
          'Conflict',
          HttpStatus.CONFLICT,
          `Payment intent id ${dto.id} is already in use`,
          COLLECTION_INSTANCE,
          ErrorCodes.CONFLICT,
        );
      }
      return toPaymentIntentDto(existing);
    }

    // ── 2. La estadía ─────────────────────────────────────────────────────
    const entry = await this.prisma.entry.findFirst({
      where: { id: dto.entryId, tenantId },
    });

    if (!entry) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Entry ${dto.entryId} was not found in entity ${tenantId}`,
        COLLECTION_INSTANCE,
        ErrorCodes.NOT_FOUND,
      );
    }

    if (entry.leftAt !== null) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        `Entry ${dto.entryId} already has an exit registered and cannot be charged`,
        COLLECTION_INSTANCE,
        ErrorCodes.PAYMENT_INTENT_ENTRY_CLOSED,
      );
    }

    // ── 3. Vencimientos perezosos ─────────────────────────────────────────
    await this.expireStaleIntents(tenantId);

    // ── 4. Token vivo (y cuenta operativa) ────────────────────────────────
    const { account, accessToken } =
      await this.tokens.getUsableAccessToken(tenantId);

    // ── 5. La caja ────────────────────────────────────────────────────────
    //
    // Se puede estar `linked` y sin POS: la vinculación crea Store y POS en
    // llamadas separadas y una de ellas puede haber quedado a medias. Code
    // propio y no `MP_NOT_LINKED` porque la salida es distinta —un
    // `POST .../pos/resync`, no re-autorizar— y el dueño tiene que saber cuál
    // de las dos hacer.
    if (!account.externalPosId) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        `Mercado Pago account of entity ${tenantId} has no POS provisioned yet. Re-sync the POS before charging.`,
        COLLECTION_INSTANCE,
        ErrorCodes.MP_POS_NOT_PROVISIONED,
      );
    }

    // ── 6. La fila, ANTES de Mercado Pago ─────────────────────────────────
    let intent: PaymentIntent;
    try {
      intent = await this.prisma.paymentIntent.create({
        data: {
          id: dto.id,
          tenantId,
          entryId: dto.entryId,
          status: PaymentIntentStatus.created,
          amount: new Prisma.Decimal(dto.amount),
          expiresAt: new Date(Date.now() + INTENT_TTL_MS),
          createdByUserId: user.id,
        },
      });
    } catch (error) {
      throw await this.mapLiveConflict(error, tenantId, dto.entryId);
    }

    // ── 7. La orden en Mercado Pago ───────────────────────────────────────
    //
    // 🔴 El body se arma desde `intent`, LA FILA PERSISTIDA, y no desde `dto`.
    // Parece lo mismo (hoy los valores coinciden) y NO lo es: la recuperación
    // de un intento colgado en `created` consiste en re-POSTear con la MISMA
    // `X-Idempotency-Key`, y Mercado Pago sólo devuelve la orden original si el
    // body es byte a byte idéntico. La fila es lo único que sigue existiendo
    // cuando el `dto` original ya no está —otro proceso, otro día, el
    // reconciliador—, así que es la única fuente que puede reproducirlo.
    //
    // Corolario: NADA de lo que va acá abajo puede calcularse en el momento.
    // Ni un `new Date()`, ni un monto recomputado, ni un `randomUUID()`.
    const amount = intent.amount.toFixed(2);
    const input: MpOrderInput = {
      externalReference: intent.id,
      externalPosId: account.externalPosId,
      totalAmount: amount,
      description: ORDER_DESCRIPTION,
      expirationTime: MP_EXPIRATION_TIME,
      items: [
        {
          title: ORDER_ITEM_TITLE,
          unitPrice: amount,
          quantity: 1,
          unitMeasure: ORDER_ITEM_UNIT_MEASURE,
          // El UUID de la estadía: opaco, estable y sin un dato personal
          // adentro. Sirve para cruzar un cobro con su estadía desde el panel
          // de Mercado Pago sin tener que exponer la patente.
          externalCode: intent.entryId,
        },
      ],
    };

    let order: MpOrder;
    try {
      order = await this.mpApi.createOrder(
        accessToken,
        input,
        idempotencyKeyFor('create', intent.id),
      );
    } catch (error) {
      // ── 9. Fallo ────────────────────────────────────────────────────────
      //
      // La fila NO se borra. Un `failed` con motivo es el rastro de que se
      // intentó cobrar y no se pudo; borrarlo dejaría al operario mirando una
      // pantalla que dice "no pasó nada" cuando quizás la orden sí se creó del
      // otro lado. Además el índice único parcial deja de considerarlo vivo
      // apenas pasa a `failed`, así que no bloquea el reintento.
      await this.prisma.paymentIntent.updateMany({
        where: {
          id: intent.id,
          tenantId,
          status: { in: [PaymentIntentStatus.created] },
        },
        data: {
          status: PaymentIntentStatus.failed,
          failureReason: describeFailure(error),
        },
      });
      throw error;
    }

    // ── 8. Éxito ──────────────────────────────────────────────────────────
    //
    // 🔴 Son DOS escrituras y el orden importa.
    //
    // El `mp_order_id` se persiste INCONDICIONALMENTE, sin guarda de estado y
    // antes que nada: es el único identificador con el que después se puede
    // hacer `GET /v1/orders/{id}` o cancelar la orden. Si se perdiera, el cobro
    // queda ciego —hay una orden viva en la caja de un cliente y no tenemos
    // cómo nombrarla— y eso es peor que cualquier estado inconsistente. No es
    // una transición de estado: es identidad, y la identidad no compite con
    // nadie.
    await this.prisma.paymentIntent.updateMany({
      where: { id: intent.id, tenantId },
      data: {
        mpOrderId: order.id,
        mpStatus: order.status,
        mpStatusDetail: order.statusDetail,
      },
    });

    // El paso a `pending` SÍ es una transición, así que va guardado. `count: 0`
    // acá es un caso normal y no un error: significa que el webhook llegó tan
    // rápido que ya movió la fila a `approved`. El pago le gana al trámite.
    await this.prisma.paymentIntent.updateMany({
      where: { id: intent.id, tenantId, status: PaymentIntentStatus.created },
      data: { status: PaymentIntentStatus.pending },
    });

    return this.requireIntent(tenantId, intent.id);
  }

  /**
   * Un intento puntual. Es el endpoint que el desktop poolea cada ~5 segundos
   * mientras el modal de cobro está abierto.
   *
   * ## Por qué vence acá y no sólo en el webhook
   *
   * El argumento intuitivo —"MP no avisa cuando un QR vence, así que hay que
   * mirarlo nosotros"— es FALSO, y conviene dejarlo escrito para que nadie
   * borre esto creyendo que corrige un malentendido: Mercado Pago **sí** emite
   * `order.expired`. Verificado contra la doc de notificaciones de la API de
   * Orders, que lista SEIS acciones: `order.processed`, `order.canceled`,
   * `order.refunded`, `order.action_required`, `order.failed` y
   * `order.expired`.
   *
   * ⚠️ Nota para el webhook (tanda 3): esas seis salen de la página de
   * notificaciones de Orders, que está redactada desde Point. NO está
   * confirmado que las seis apliquen a QR —`order.action_required` habla de
   * confirmar en la TERMINAL, que en QR no existe—, así que el webhook tiene
   * que tratar la acción desconocida como ignorable y no como error. Lo único
   * verificado y lo único que este método necesita es que `order.expired`
   * existe.
   *
   * Esto NO reemplaza al webhook: es DEFENSA EN PROFUNDIDAD, y la asimetría que
   * la justifica es esta. Un webhook es entrega best-effort. Si el de
   * `order.expired` se pierde —deploy en el momento justo, red, un 500
   * nuestro—, el intento queda colgado en `pending` para siempre, y por el
   * índice único parcial eso bloquea PARA SIEMPRE que esa estadía (y esa caja)
   * generen otro cobro. Un evento cuya ausencia produce un callejón sin salida
   * permanente no se puede dar por recibido.
   *
   * Y el costo de cubrirlo es ridículo: cinco líneas en un endpoint que ya se
   * ejecuta cada cinco segundos, sin una sola query extra en el camino feliz.
   * Esa relación —bloqueo permanente contra cinco líneas— es toda la
   * justificación.
   */
  async getById(tenantId: string, id: string): Promise<PaymentIntentDto> {
    const intent = await this.requireIntentRow(tenantId, id);

    const expired =
      intent.expiresAt.getTime() < Date.now() &&
      OPEN_STATUSES.includes(intent.status);

    if (!expired) return toPaymentIntentDto(intent);

    // Guarda, como toda transición: entre el `SELECT` de arriba y este `UPDATE`
    // el webhook pudo haber acreditado el pago, y la plata le gana al reloj.
    await this.prisma.paymentIntent.updateMany({
      where: { id, tenantId, status: { in: [...OPEN_STATUSES] } },
      data: { status: PaymentIntentStatus.expired },
    });

    // Se relee en lugar de devolver `{ ...intent, status: expired }` porque si
    // la guarda no matcheó, el estado real es el que escribió el otro.
    return this.requireIntent(tenantId, id);
  }

  /**
   * Cancela el intento: lo que pasa cuando el operario cierra el modal de
   * cobro.
   *
   * ## 🔴 Cancelar del lado de Mercado Pago NO es opcional
   *
   * El QR de la playa es ESTÁTICO: un cartel impreso atado al POS. Si el
   * intento se cancela sólo de nuestro lado, la orden sigue viva sobre esa caja
   * hasta que Mercado Pago la venza, y **el próximo cliente que escanee el
   * cartel paga el monto del auto anterior**. No es una inconsistencia
   * cosmética entre dos sistemas: es plata cobrada mal, a alguien que no tiene
   * forma de darse cuenta.
   *
   * ## Y si Mercado Pago falla al cancelar, igual se cancela localmente
   *
   * Es la decisión incómoda del método, así que va escrita. Las dos opciones
   * son malas y hay que elegir la menos mala:
   *
   *  - Dejarlo vivo localmente hasta que MP confirme: el intento sigue contando
   *    para `payment_intents_tenant_live_idx`, así que la caja queda BLOQUEADA
   *    —la playa entera no puede cobrar con QR— por un fallo que puede ser un
   *    timeout de red de MP y durar lo que dure el incidente.
   *  - Cancelarlo igual: la caja se libera, pero puede haber quedado una orden
   *    viva del otro lado.
   *
   * Gana la segunda, con dos atenuantes concretos que la primera no tiene: la
   * orden que quedó viva vence sola en `PT5M` (no es permanente), y queda
   * auditado con `severity: 'warn'` para que alguien mire. Un bloqueo total de
   * la caja no vence solo ni le avisa a nadie.
   */
  async cancel(
    tenantId: string,
    id: string,
    user: User,
  ): Promise<PaymentIntentDto> {
    const intent = await this.requireIntentRow(tenantId, id);

    if (!OPEN_STATUSES.includes(intent.status)) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        `Payment intent ${id} is ${intent.status} and can no longer be canceled`,
        ITEM_INSTANCE,
        ErrorCodes.PAYMENT_INTENT_NOT_CANCELABLE,
      );
    }

    if (intent.mpOrderId) {
      await this.cancelOnMercadoPago(tenantId, intent, intent.mpOrderId, user);
    }

    await this.prisma.paymentIntent.updateMany({
      where: { id, tenantId, status: { in: [...OPEN_STATUSES] } },
      data: { status: PaymentIntentStatus.canceled },
    });

    return this.requireIntent(tenantId, id);
  }

  /**
   * Los cobros acreditados que todavía no se convirtieron en una
   * `PaymentTransaction`: los PAGOS HUÉRFANOS.
   *
   * Existen porque el pago y el cierre de la estadía son dos momentos
   * distintos: el cliente paga desde el auto, y el operario cierra cuando
   * termina de atender. Entre medio hay un pago real de un tercero que el
   * sistema tiene registrado y todavía no aplicó a nada — y si el operario
   * cierra el turno sin mirarlos, ese dinero no aparece en el arqueo.
   *
   * Más nuevo primero, por `approvedAt`: el de arriba es casi siempre el auto
   * que está esperando en la salida.
   */
  async listUnconsumed(tenantId: string): Promise<PaymentIntentDto[]> {
    const intents = await this.prisma.paymentIntent.findMany({
      where: { tenantId, status: PaymentIntentStatus.approved },
      orderBy: { approvedAt: 'desc' },
    });

    return intents.map(toPaymentIntentDto);
  }

  /**
   * Marca como `expired` todo lo que ya venció en esta playa.
   *
   * ⚠️ Barre por `tenantId` y NO por `entryId`, y la diferencia es lo que hace
   * que la playa no se trabe. Con el índice `payment_intents_tenant_live_idx`,
   * un intento vencido y sin barrer de CUALQUIER estadía bloquea el alta de
   * CUALQUIER otra: si el barrido fuera por estadía, el operario que intenta
   * cobrar el auto B nunca limpiaría el intento podrido del auto A, y la caja
   * quedaría muerta hasta que pase el reconciliador. Filtrar por playa incluye
   * a la estadía en cuestión, así que cubre las dos restricciones de una.
   *
   * No es redundante con el reconciliador: este barrido es sincrónico y corre
   * justo antes del `INSERT` que el índice puede rechazar. El reconciliador es
   * periódico y puede estar a minutos de distancia — o caído.
   */
  private async expireStaleIntents(tenantId: string): Promise<void> {
    await this.prisma.paymentIntent.updateMany({
      where: {
        tenantId,
        status: { in: [...OPEN_STATUSES] },
        expiresAt: { lt: new Date() },
      },
      data: { status: PaymentIntentStatus.expired },
    });
  }

  /**
   * Pide a Mercado Pago que cancele la orden, y se traga el error a propósito.
   *
   * Todo el camino va adentro del `try`, incluido `getUsableAccessToken`: una
   * cuenta revocada o con el token vencido tira una excepción ANTES de la
   * llamada HTTP, y ese caso tiene que terminar igual que un fallo de red —con
   * el intento cancelado localmente y auditado—, no tirando un 409 que le
   * impide al operario cerrar el modal.
   */
  private async cancelOnMercadoPago(
    tenantId: string,
    intent: PaymentIntent,
    mpOrderId: string,
    user: User,
  ): Promise<void> {
    try {
      const { accessToken } = await this.tokens.getUsableAccessToken(tenantId);
      await this.mpApi.cancelOrder(
        accessToken,
        mpOrderId,
        idempotencyKeyFor('cancel', intent.id),
      );
    } catch (error) {
      const reason = describeFailure(error);

      this.logger.warn(
        `Mercado Pago order ${mpOrderId} could not be canceled (${reason}). ` +
          `Payment intent ${intent.id} is being canceled locally anyway to free the till; ` +
          'the order may stay alive on the QR until Mercado Pago expires it.',
      );

      await this.audit.record({
        action: AuditActions.PAYMENT_INTENT_CANCEL_MP_FAILED,
        entityType: 'payment_intent',
        entityId: intent.id,
        actorUserId: user.id,
        tenantId,
        severity: 'warn',
        metadata: { mpOrderId, reason },
      });
    }
  }

  /** La fila, ya scopeada por playa. 404 si no está. */
  private async requireIntentRow(
    tenantId: string,
    id: string,
  ): Promise<PaymentIntent> {
    const intent = await this.prisma.paymentIntent.findFirst({
      where: { id, tenantId },
    });

    if (!intent) {
      // UN SOLO code para "no existe" y "es de otra playa", igual que
      // `CASH_SESSION_NOT_FOUND`: distinguirlos le confirmaría a un tercero que
      // el id existe en algún lado.
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Payment intent ${id} was not found in entity ${tenantId}`,
        ITEM_INSTANCE,
        ErrorCodes.PAYMENT_INTENT_NOT_FOUND,
      );
    }

    return intent;
  }

  /** Igual que `requireIntentRow` pero ya mapeado al contrato HTTP. */
  private async requireIntent(
    tenantId: string,
    id: string,
  ): Promise<PaymentIntentDto> {
    return toPaymentIntentDto(await this.requireIntentRow(tenantId, id));
  }

  /**
   * Traduce el P2002 del `INSERT` a un 409 que el operario pueda entender.
   *
   * 🔴 SON DOS MENSAJES DISTINTOS y eso es el punto entero de este método. Los
   * dos índices únicos parciales de la tabla frenan cosas diferentes, y lo que
   * el operario tiene que hacer también:
   *
   *  - `payment_intents_entry_live_idx` → ya hay un cobro vivo para ESTE auto.
   *    Lo más probable es que él mismo haya apretado dos veces, o que el cobro
   *    esté abierto en otra terminal. Mirá el que ya existe.
   *  - `payment_intents_tenant_live_idx` → hay un cobro en curso en LA CAJA,
   *    de OTRO auto. No es suyo y no lo ve en su pantalla. Tiene que esperar
   *    o cancelar el anterior.
   *
   * Darle el mismo mensaje a los dos casos manda al operario a buscar un cobro
   * que no está en su estadía, se rinde, y termina cobrando en efectivo un auto
   * que ya tenía el QR listo.
   *
   * ## ⚠️ Gotcha verificado: con Prisma 7 + `@prisma/adapter-pg` NO hay `meta.target`
   *
   * El chequeo clásico `error.meta?.target` —que es lo que hacen
   * `VehiclesService` y `VehicleTypesService`— devuelve `undefined` acá. Con el
   * driver adapter, el `meta` que llega es:
   *
   * ```json
   * { "modelName": "PaymentIntent",
   *   "driverAdapterError": { "cause": {
   *     "originalMessage": "duplicate key value violates unique constraint \"payment_intents_tenant_live_idx\"",
   *     "constraint": { "fields": ["tenant_id"] } } } }
   * ```
   *
   * Verificado contra la base local con los dos índices. Por eso se busca sobre
   * el `meta` serializado —que cubre tanto el nombre del índice como el campo,
   * y sobreviviría a que Prisma vuelva a poblar `target`— y no sobre una
   * propiedad concreta que cambia de lugar entre versiones.
   *
   * Si aun así no se puede decidir, se pregunta a los DATOS: hay un `SELECT`
   * extra, pero sólo en el camino de error y sólo si el formato cambió otra
   * vez. Preferible a adivinar y mentirle al operario.
   */
  private async mapLiveConflict(
    error: unknown,
    tenantId: string,
    entryId: string,
  ): Promise<unknown> {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      return error;
    }

    const evidence = JSON.stringify(error.meta ?? {});
    let blockedByEntry =
      evidence.includes('entry_live_idx') || evidence.includes('entry_id');

    if (
      !blockedByEntry &&
      !evidence.includes('tenant_live_idx') &&
      !evidence.includes('tenant_id')
    ) {
      blockedByEntry =
        (await this.prisma.paymentIntent.count({
          where: {
            entryId,
            tenantId,
            status: {
              in: [...OPEN_STATUSES, PaymentIntentStatus.approved],
            },
          },
        })) > 0;
    }

    return blockedByEntry
      ? new FormattedException(
          'Conflict',
          HttpStatus.CONFLICT,
          `Entry ${entryId} already has a live payment intent. Check the one that is already open instead of creating a second one.`,
          COLLECTION_INSTANCE,
          ErrorCodes.PAYMENT_INTENT_ALREADY_OPEN,
        )
      : new FormattedException(
          'Conflict',
          HttpStatus.CONFLICT,
          `The till of entity ${tenantId} already has a QR charge in progress for another stay. Wait for it to finish or cancel it first.`,
          COLLECTION_INSTANCE,
          ErrorCodes.PAYMENT_INTENT_POS_BUSY,
        );
  }
}

/**
 * La `X-Idempotency-Key` de una operación sobre un intento.
 *
 * DETERMINÍSTICA: sale de un hash del `id` del intento y nada más, así que
 * reintentar la misma operación produce la misma key y Mercado Pago devuelve la
 * orden original en vez de crear una segunda. Un `randomUUID()` acá convertiría
 * cada reintento en una orden nueva y el doble cobro dejaría de ser teórico.
 *
 * NAMESPACEADA POR OPERACIÓN (`create:` / `cancel:`): cancelar es una solicitud
 * DISTINTA, con otro body. Reusar la key del create para el cancel devuelve
 * `409 idempotency_key_already_used` —la ventana de la key es de 24 h—, que es
 * justo el error que uno no quiere cuando está tratando de liberar la caja.
 *
 * Se hashea en vez de mandar `create:<uuid>` en crudo por higiene: la key viaja
 * en un header a un tercero y termina en SUS logs. Un sha256 en hex son 64
 * caracteres, entra en cualquier límite razonable, y no le cuenta a Mercado
 * Pago nada sobre la forma de nuestros ids.
 */
function idempotencyKeyFor(
  operation: 'create' | 'cancel',
  intentId: string,
): string {
  return createHash('sha256').update(`${operation}:${intentId}`).digest('hex');
}

/**
 * Resumen del fallo apto para `payment_intents.failure_reason`.
 *
 * Sólo el `code` estable del ProblemDetails más el status, o el nombre del
 * error. NUNCA el mensaje crudo: esa columna la lee soporte, se exporta y
 * termina en planillas, y el mensaje crudo puede arrastrar un fragmento de la
 * respuesta de Mercado Pago. El detalle largo ya quedó en el log de
 * `MpApiClient`, que es donde tiene que estar.
 */
function describeFailure(error: unknown): string {
  if (error instanceof FormattedException) {
    const body: unknown = error.getResponse();
    if (body !== null && typeof body === 'object' && 'code' in body) {
      return `${String(body.code)} (HTTP ${error.getStatus()})`;
    }
    return `HTTP ${error.getStatus()}`;
  }
  return error instanceof Error ? error.name : 'unknown error';
}
