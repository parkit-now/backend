import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { MembershipRole, PaymentIntentStatus, Prisma } from '@prisma/client';
import type { PaymentMethodType, User, UserMembership } from '@prisma/client';
import { AuditActions } from '../audit/audit.service';
import type { CreatedInvoice } from '../arca/invoices.service';
import { InvoicesService } from '../arca/invoices.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { CloseEntryDto } from './dto/close-entry.dto';
import { CloseEntryResponseDto } from './dto/close-entry-response.dto';
import { CorrectEntryDto } from './dto/correct-entry.dto';
import { CreateEntryDto } from './dto/create-entry.dto';
import { EntryChangesQueryDto } from './dto/entry-changes-query.dto';
import { EntryDto } from './dto/entry.dto';
import { LprEntryDto } from './dto/lpr-entry.dto';
import { calcStayPrice } from './pricing';
import { PaymentLineDto } from '../payment-transactions/dto/payment-line.dto';
import { inferPaymentMethodTypeFromName } from '../payment-transactions/payment-method-type';

type PrismaEntry = Prisma.EntryGetPayload<Record<string, never>>;
type EntryWithAuditRelations = Prisma.EntryGetPayload<{
  include: { cashSession: true; paymentTransactions: true };
}>;
type PaymentSnapshot = {
  id: string;
  paymentMethodId: string | null;
  paymentMethodName: string;
  amount: number;
};
type EntryAuditSnapshot = {
  id: string;
  plate: string;
  color: string | null;
  cochera: string | null;
  notes: string | null;
  enteredAt: string;
  leftAt: string | null;
  amountPaid: number | null;
  vehicleBrand: string | null;
  vehicleModel: string | null;
  rateId: string | null;
  rateSnapshotName: string | null;
  rateSnapshotHourPriceArs: number | null;
  rateSnapshotStayPriceArs: number | null;
  rateSnapshotFractionPriceArs: number | null;
  rateSnapshotMediaEstadiaPriceArs: number | null;
  cashSessionId: string | null;
  ticketNumber: number | null;
  payments: PaymentSnapshot[];
};
type CorrectionEconomicImpact = {
  suggestedBefore: number | null;
  suggestedAfter: number | null;
  suggestedDelta: number | null;
  chargedBefore: number | null;
  chargedAfter: number | null;
  chargedDelta: number | null;
  deltaVsSuggestedAfter: number | null;
};

const MONEY_EPSILON = 0.005;
const UNDERCHARGE_RATIO = 0.95;

function toDto(entry: PrismaEntry): EntryDto {
  return {
    id: entry.id,
    tenantId: entry.tenantId,
    plate: entry.plate,
    color: entry.color,
    cochera: entry.cochera,
    notes: entry.notes,
    enteredAt: entry.enteredAt,
    leftAt: entry.leftAt,
    amountPaid: entry.amountPaid !== null ? Number(entry.amountPaid) : null,
    vehicleBrand: entry.vehicleBrand,
    vehicleModel: entry.vehicleModel,
    rateId: entry.rateId,
    rateSnapshotName: entry.rateSnapshotName,
    rateSnapshotHourPriceArs:
      entry.rateSnapshotHourPriceArs !== null
        ? Number(entry.rateSnapshotHourPriceArs)
        : null,
    rateSnapshotStayPriceArs:
      entry.rateSnapshotStayPriceArs !== null
        ? Number(entry.rateSnapshotStayPriceArs)
        : null,
    rateSnapshotFractionPriceArs:
      entry.rateSnapshotFractionPriceArs !== null
        ? Number(entry.rateSnapshotFractionPriceArs)
        : null,
    rateSnapshotMediaEstadiaPriceArs:
      entry.rateSnapshotMediaEstadiaPriceArs !== null
        ? Number(entry.rateSnapshotMediaEstadiaPriceArs)
        : null,
    cashSessionId: entry.cashSessionId,
    ticketNumber: entry.ticketNumber,
    source: entry.source,
    vehicleType: entry.vehicleType,
    entryImageUrl: entry.entryImageUrl,
    entryCameraId: entry.entryCameraId,
    exitImageUrl: entry.exitImageUrl,
    exitCameraId: entry.exitCameraId,
    whitelistId: entry.whitelistId,
    version: entry.version,
    syncSeq: entry.syncSeq,
    updatedAt: entry.updatedAt,
  };
}

function toNumber(
  value: Prisma.Decimal | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

/**
 * Monto que el operador DEBERÍA haber cobrado, según el snapshot de tarifa
 * congelado en el ingreso.
 *
 * Wrapper delgado: la política de cobro vive en `calcStayPrice`, gemela de la
 * del desktop. Acá solo se convierten fechas a minutos y `null` a 0 — el motor
 * ya distingue "precio ausente" de "precio cero" donde importa.
 */
function calcSuggestedAmount(input: {
  enteredAt: Date;
  leftAt: Date;
  hourPrice: number | null;
  stayPrice: number | null;
  fractionPrice: number | null;
  mediaEstadiaPrice: number | null;
}): number {
  const totalMinutes =
    (input.leftAt.getTime() - input.enteredAt.getTime()) / 60000;

  return calcStayPrice(totalMinutes, {
    hour: input.hourPrice ?? 0,
    fraction: input.fractionPrice ?? 0,
    mediaEstadia: input.mediaEstadiaPrice ?? 0,
    stay: input.stayPrice ?? 0,
  });
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Resuelve el `payment_method_type` de cada línea de pago: el snapshot del que
 * depende el arqueo de caja del desktop.
 *
 * La columna es NOT NULL y sin DEFAULT (ver
 * 20260913200901_payment_transactions_method_type_snapshot.sql), así que esto
 * corre en TODOS los caminos que insertan pagos. Deliberadamente no hay
 * DEFAULT: un 'other' por omisión sobre un cobro en efectivo haría desaparecer
 * la plata del arqueo en silencio, que es el bug que estamos matando.
 *
 * Precedencia, de mejor a peor:
 *
 *   1. `line.paymentMethodType` — lo que mandó el cliente. Gana porque esto es
 *      un SNAPSHOT: vale lo que el operador tenía en pantalla al cobrar, no lo
 *      que la tabla diga después. Mismo criterio que `paymentMethodName`, que
 *      tampoco se pisa con el nombre actual del método.
 *   2. `payment_methods.type` por id. Exacto, y es lo que salva a los desktops
 *      viejos: todavía no mandan el tipo, pero sí mandan el id.
 *   3. Inferir del nombre. Último recurso, sólo para un cliente viejo cobrando
 *      con un método ya borrado. Ver `inferPaymentMethodTypeFromName`.
 *
 * Una sola query para todas las líneas, no una por línea.
 */
async function resolvePaymentLineTypes(
  tx: Pick<Prisma.TransactionClient, 'paymentMethod'>,
  tenantId: string,
  lines: PaymentLineDto[],
): Promise<Map<string, PaymentMethodType>> {
  const resolved = new Map<string, PaymentMethodType>();

  const idsToLookUp = [
    ...new Set(
      lines
        .filter((line) => line.paymentMethodType === undefined)
        .map((line) => line.paymentMethodId)
        .filter((id): id is string => !!id),
    ),
  ];

  const typeById = new Map<string, PaymentMethodType>();
  if (idsToLookUp.length > 0) {
    const methods = await tx.paymentMethod.findMany({
      where: { tenantId, id: { in: idsToLookUp } },
      select: { id: true, type: true },
    });
    for (const method of methods) typeById.set(method.id, method.type);
  }

  for (const line of lines) {
    resolved.set(
      line.id,
      line.paymentMethodType ??
        (line.paymentMethodId
          ? typeById.get(line.paymentMethodId)
          : undefined) ??
        inferPaymentMethodTypeFromName(line.paymentMethodName),
    );
  }

  return resolved;
}

/**
 * Quema los `payment_intents` que financian este cierre: `approved` →
 * `consumed`, DENTRO de la transacción que cierra la estadía.
 *
 * ## Por qué va acá adentro y no en un endpoint aparte
 *
 * Porque cerrar la estadía y quemar el intento tienen que ser ATÓMICOS, y las
 * dos mitades rotas cuestan plata en direcciones opuestas:
 *
 *   · Si la estadía cierra y el intento queda en `approved`, ese mismo cobro se
 *     puede volver a mandar en el cierre de OTRA estadía. El arqueo cuenta dos
 *     veces una plata que entró una sola vez, y el faltante se lo come el
 *     operador del turno.
 *   · Si el intento se quema y el cierre falla, el cliente pagó y la estadía
 *     sigue abierta: el auto no sale sin que alguien cobre de nuevo a mano.
 *
 * Van juntos o no va ninguno. Por eso recibe el `tx` y no el cliente de Prisma.
 *
 * ## Por qué `updateMany` con guarda y no `update` + `if`
 *
 * Porque el `WHERE` completo —id, playa, estadía, `approved` y monto— viaja en
 * la MISMA sentencia que el `SET`, así que Postgres lo resuelve bajo el lock de
 * la fila. Un `findFirst` seguido de un `update` dejaría una ventana entre la
 * lectura y la escritura, y esa ventana es exactamente el doble consumo que
 * estamos evitando: dos cierres concurrentes leerían `approved` los dos.
 *
 * `count === 0` cubre de una los cinco casos malos —ya consumido, de otra
 * estadía, de otra playa, monto distinto, nunca aprobado— y todos salen por el
 * mismo 409. El porqué de no distinguirlos está en
 * `ErrorCodes.PAYMENT_INTENT_NOT_CONSUMABLE`.
 *
 * ## El `tenantId` explícito no es decorativo
 *
 * ⚠️ `PaymentIntent` NO está en `TENANT_MODELS` (`src/database/prisma-tenant.ts`)
 * a propósito: sus dos escritores principales —el webhook público de Mercado
 * Pago y el reconciliador— corren sin tenant en el `AsyncLocalStorage`. La
 * extensión de Prisma NO inyecta `WHERE tenant_id` acá. Sacarlo del `where` de
 * abajo convierte esto en una fuga entre playas sin red debajo.
 *
 * ## El epsilon
 *
 * `amount` es `Decimal(12,2)` en Postgres y `number` en JS. `MONEY_EPSILON`
 * (medio centavo) evita que un desfasaje de representación trabe un cobro
 * legítimo; es la misma tolerancia que ya usa el detector de subcobro. El rango
 * sigue siendo mucho más chico que un centavo, así que no deja pasar un intent
 * de $2.000 contra una línea de $2.001.
 */
async function consumePaymentIntents(
  tx: Pick<Prisma.TransactionClient, 'paymentIntent'>,
  tenantId: string,
  entryId: string,
  leftAt: Date,
  lines: PaymentLineDto[],
): Promise<void> {
  // El 99% de los cierres son en efectivo y no mandan ningún intento: se van
  // por acá sin pagar una sola query de más.
  const withIntent = lines.filter((line) => line.paymentIntentId);
  if (withIntent.length === 0) return;

  for (const line of withIntent) {
    const burned = await tx.paymentIntent.updateMany({
      where: {
        id: line.paymentIntentId,
        tenantId,
        entryId,
        status: PaymentIntentStatus.approved,
        amount: {
          gte: line.amount - MONEY_EPSILON,
          lte: line.amount + MONEY_EPSILON,
        },
      },
      data: {
        status: PaymentIntentStatus.consumed,
        consumedAt: leftAt,
        // El `payment_transaction` que acaba de nacer. El id lo generó el
        // cliente (UUIDv7, ver `PaymentLineDto.id`), así que ya lo tenemos sin
        // releer nada. No hay FK: `payment_transactions` es tenant-local y con
        // borrado lógico, ver el docblock del modelo.
        paymentTransactionId: line.id,
      },
    });

    if (burned.count === 0) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        `Payment intent ${line.paymentIntentId} cannot be consumed: it was already consumed, belongs to another entry or entity, is not approved, or its amount does not match the payment line.`,
        `/tenants/:tenantId/entries/${entryId}`,
        ErrorCodes.PAYMENT_INTENT_NOT_CONSUMABLE,
      );
    }
  }
}

function activePayments(entry: EntryWithAuditRelations): PaymentSnapshot[] {
  return entry.paymentTransactions
    .filter((tx) => (tx as { deletedAt?: Date | null }).deletedAt == null)
    .map((tx) => ({
      id: tx.id,
      paymentMethodId: tx.paymentMethodId,
      paymentMethodName: tx.paymentMethodName,
      amount: Number(tx.amount),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function snapshotEntry(entry: EntryWithAuditRelations): EntryAuditSnapshot {
  return {
    id: entry.id,
    plate: entry.plate,
    color: entry.color,
    cochera: entry.cochera,
    notes: entry.notes,
    enteredAt: entry.enteredAt.toISOString(),
    leftAt: entry.leftAt ? entry.leftAt.toISOString() : null,
    amountPaid: toNumber(entry.amountPaid),
    vehicleBrand: entry.vehicleBrand,
    vehicleModel: entry.vehicleModel,
    rateId: entry.rateId,
    rateSnapshotName: entry.rateSnapshotName,
    rateSnapshotHourPriceArs: toNumber(entry.rateSnapshotHourPriceArs),
    rateSnapshotStayPriceArs: toNumber(entry.rateSnapshotStayPriceArs),
    rateSnapshotFractionPriceArs: toNumber(entry.rateSnapshotFractionPriceArs),
    rateSnapshotMediaEstadiaPriceArs: toNumber(
      entry.rateSnapshotMediaEstadiaPriceArs,
    ),
    cashSessionId: entry.cashSessionId,
    ticketNumber: entry.ticketNumber,
    payments: activePayments(entry),
  };
}

function diffSnapshots(
  before: EntryAuditSnapshot,
  after: EntryAuditSnapshot,
): string[] {
  const fields: Array<keyof EntryAuditSnapshot> = [
    'plate',
    'color',
    'cochera',
    'notes',
    'enteredAt',
    'leftAt',
    'amountPaid',
    'vehicleBrand',
    'vehicleModel',
    'rateId',
    'rateSnapshotName',
    'rateSnapshotHourPriceArs',
    'rateSnapshotStayPriceArs',
    'rateSnapshotFractionPriceArs',
    'rateSnapshotMediaEstadiaPriceArs',
    'payments',
  ];

  return fields.filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
}

function hasPaymentAmountChange(
  before: PaymentSnapshot[],
  after: PaymentSnapshot[],
): boolean {
  const beforeTotal = before.reduce((sum, payment) => sum + payment.amount, 0);
  const afterTotal = after.reduce((sum, payment) => sum + payment.amount, 0);
  return Math.abs(beforeTotal - afterTotal) > MONEY_EPSILON;
}

function snapshotSuggestedAmount(snapshot: EntryAuditSnapshot): number | null {
  if (!snapshot.enteredAt || !snapshot.leftAt) return null;
  const enteredAt = new Date(snapshot.enteredAt);
  const leftAt = new Date(snapshot.leftAt);
  if (
    Number.isNaN(enteredAt.getTime()) ||
    Number.isNaN(leftAt.getTime()) ||
    leftAt.getTime() <= enteredAt.getTime()
  ) {
    return null;
  }
  return roundMoney(
    calcSuggestedAmount({
      enteredAt,
      leftAt,
      hourPrice: snapshot.rateSnapshotHourPriceArs,
      stayPrice: snapshot.rateSnapshotStayPriceArs,
      fractionPrice: snapshot.rateSnapshotFractionPriceArs,
      mediaEstadiaPrice: snapshot.rateSnapshotMediaEstadiaPriceArs,
    }),
  );
}

function snapshotChargedAmount(snapshot: EntryAuditSnapshot): number | null {
  if (snapshot.amountPaid !== null) return roundMoney(snapshot.amountPaid);
  if (snapshot.payments.length === 0) return null;
  return roundMoney(
    snapshot.payments.reduce((sum, payment) => sum + payment.amount, 0),
  );
}

function delta(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : roundMoney(left - right);
}

function correctionEconomicImpact(
  before: EntryAuditSnapshot,
  after: EntryAuditSnapshot,
): CorrectionEconomicImpact {
  const suggestedBefore = snapshotSuggestedAmount(before);
  const suggestedAfter = snapshotSuggestedAmount(after);
  const chargedBefore = snapshotChargedAmount(before);
  const chargedAfter = snapshotChargedAmount(after);
  return {
    suggestedBefore,
    suggestedAfter,
    suggestedDelta: delta(suggestedAfter, suggestedBefore),
    chargedBefore,
    chargedAfter,
    chargedDelta: delta(chargedAfter, chargedBefore),
    deltaVsSuggestedAfter: delta(suggestedAfter, chargedAfter),
  };
}

function actorRole(membership?: UserMembership | null): string {
  return membership?.role ?? 'admin';
}

type EntryChangesResponse = {
  items: EntryDto[];
  maxSeq: number;
};

@Injectable()
export class EntriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    // Opcional: la facturación es un agregado del cierre, no una dependencia.
    // Sin ella (tests, módulos que no importan ArcaModule) se cierra igual.
    @Optional() private readonly invoices?: InvoicesService,
  ) {}

  async createEntry(data: CreateEntryDto): Promise<EntryDto> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const plate = data.plate.toUpperCase();

    const entry = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.entry.findFirst({
        where: { tenantId, plate, leftAt: null },
      });
      if (existing) {
        throw new FormattedException(
          'Duplicate active stay',
          HttpStatus.CONFLICT,
          `Plate ${plate} already has an active stay.`,
          `/tenants/${tenantId}/entries`,
          ErrorCodes.ENTRY_DUPLICATE_ACTIVE_STAY,
        );
      }

      return tx.entry.create({
        data: {
          id: data.id,
          tenantId,
          plate,
          color: data.color,
          cochera: data.cochera,
          notes: data.notes,
          enteredAt: new Date(data.enteredAt),
          vehicleBrand: data.vehicleBrand,
          vehicleModel: data.vehicleModel,
          rateId: data.rateId,
          rateSnapshotName: data.rateSnapshotName,
          rateSnapshotHourPriceArs: data.rateSnapshotHourPriceArs,
          rateSnapshotStayPriceArs: data.rateSnapshotStayPriceArs,
          rateSnapshotFractionPriceArs: data.rateSnapshotFractionPriceArs,
          rateSnapshotMediaEstadiaPriceArs:
            data.rateSnapshotMediaEstadiaPriceArs,
          cashSessionId: data.cashSessionId,
          ticketNumber: data.ticketNumber,
        },
      });
    });

    return toDto(entry);
  }

  async findAll(): Promise<EntryDto[]> {
    const tenantPrisma = this.prisma.getTenantClient();
    const entries = await tenantPrisma.entry.findMany({
      orderBy: [{ enteredAt: 'desc' }],
    });
    return entries.map(toDto);
  }

  async pullChanges(
    query: EntryChangesQueryDto,
  ): Promise<EntryChangesResponse> {
    const tenantPrisma = this.prisma.getTenantClient();
    const items = await tenantPrisma.entry.findMany({
      where: { syncSeq: { gt: query.afterSeq } },
      orderBy: [{ syncSeq: 'asc' }],
      take: query.limit,
    });
    const maxSeq =
      items.length > 0 ? items[items.length - 1].syncSeq : query.afterSeq;
    return { items: items.map(toDto), maxSeq };
  }

  async closeEntry(
    entryId: string,
    expectedVersion: number,
    data: CloseEntryDto,
    user?: User,
    membership?: UserMembership | null,
  ): Promise<CloseEntryResponseDto> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const leftAt = data.leftAt ? new Date(data.leftAt) : new Date();
    let createdInvoice: CreatedInvoice | null = null;

    // Compute amountPaid: sum of payments[] if provided, otherwise use the
    // directly provided amountPaid (legacy / offline fallback).
    const computedAmount =
      data.payments && data.payments.length > 0
        ? data.payments.reduce((sum, p) => sum + p.amount, 0)
        : data.amountPaid;

    const entry = await this.prisma.$transaction(async (tx) => {
      const current = await tx.entry.findFirst({
        where: { tenantId, id: entryId },
      });
      if (!current) {
        throw new FormattedException(
          'Not Found',
          HttpStatus.NOT_FOUND,
          `Entry ${entryId} not found in this entity.`,
          `/tenants/:tenantId/entries/${entryId}`,
          ErrorCodes.NOT_FOUND,
        );
      }

      const updateData: Prisma.EntryUncheckedUpdateInput = {
        version: { increment: 1 },
        leftAt,
        amountPaid: computedAmount,
      };
      if (data.cochera !== undefined) updateData.cochera = data.cochera;
      if (data.notes !== undefined) updateData.notes = data.notes;

      const result = await tx.entry.updateMany({
        where: {
          tenantId,
          id: entryId,
          version: expectedVersion,
          leftAt: null,
        },
        data: updateData,
      });

      if (result.count === 0) {
        throw new FormattedException(
          'Conflict',
          HttpStatus.CONFLICT,
          'Entry was already closed or changed by another write. Refresh and retry.',
          `/tenants/:tenantId/entries/${entryId}`,
          ErrorCodes.CONFLICT,
        );
      }

      // Create payment transaction records if payments were provided, and burn
      // the Mercado Pago intents that funded them — todo dentro de esta misma
      // transacción, ver `consumePaymentIntents`.
      if (data.payments && data.payments.length > 0) {
        const cashSessionId =
          data.cashSessionId ??
          (
            await tx.cashSession.findFirst({
              where: { tenantId, closedAt: null },
              select: { id: true },
            })
          )?.id ??
          null;

        const typeByLineId = await resolvePaymentLineTypes(
          tx,
          tenantId,
          data.payments,
        );

        await tx.paymentTransaction.createMany({
          data: data.payments.map((p) => ({
            id: p.id,
            tenantId,
            entryId,
            cashSessionId,
            paymentMethodId: p.paymentMethodId ?? null,
            paymentMethodName: p.paymentMethodName,
            paymentMethodType: typeByLineId.get(p.id)!,
            amount: p.amount,
          })),
        });

        await consumePaymentIntents(
          tx,
          tenantId,
          entryId,
          leftAt,
          data.payments,
        );
      }

      if (computedAmount !== undefined) {
        const suggestedAmount = calcSuggestedAmount({
          enteredAt: current.enteredAt,
          leftAt,
          hourPrice: toNumber(current.rateSnapshotHourPriceArs),
          stayPrice: toNumber(current.rateSnapshotStayPriceArs),
          fractionPrice: toNumber(current.rateSnapshotFractionPriceArs),
          mediaEstadiaPrice: toNumber(current.rateSnapshotMediaEstadiaPriceArs),
        });
        if (
          suggestedAmount > 0 &&
          computedAmount < suggestedAmount * UNDERCHARGE_RATIO - MONEY_EPSILON
        ) {
          await tx.auditLog.create({
            data: {
              action: AuditActions.ENTRY_UNDERCHARGED,
              entityType: 'entry',
              entityId: entryId,
              actorUserId: user?.id ?? null,
              tenantId,
              severity: 'warn',
              metadata: {
                origin: 'operational_exit',
                plate: current.plate,
                cashSessionId: data.cashSessionId ?? current.cashSessionId,
                ticketNumber: current.ticketNumber,
                suggestedAmount: roundMoney(suggestedAmount),
                chargedAmount: roundMoney(computedAmount),
                delta: roundMoney(suggestedAmount - computedAmount),
                actorRole: actorRole(membership),
                rate: {
                  id: current.rateId,
                  name: current.rateSnapshotName,
                  hourPriceArs: toNumber(current.rateSnapshotHourPriceArs),
                  stayPriceArs: toNumber(current.rateSnapshotStayPriceArs),
                  fractionPriceArs: toNumber(
                    current.rateSnapshotFractionPriceArs,
                  ),
                  mediaEstadiaPriceArs: toNumber(
                    current.rateSnapshotMediaEstadiaPriceArs,
                  ),
                },
              },
            },
          });
        }
      }

      // La factura nace en la MISMA transacción que el cierre (pendiente o
      // "no requiere"); se emite recién después del commit, ver abajo.
      if (this.invoices && computedAmount !== undefined) {
        createdInvoice = await this.invoices.createForClosedEntry(tx, {
          tenantId,
          entryId,
          total: computedAmount,
          paymentMethodIds: (data.payments ?? []).map((p) => p.paymentMethodId),
          receiverCuit: data.invoiceReceiverCuit,
        });

        // Cobro que tenía que facturarse y no se pudo por el certificado
        // vencido: queda en la auditoría para que el dueño lo vea en la web
        // (el operario sólo ve el aviso en el cobro).
        if (createdInvoice?.errorCode === ErrorCodes.ARCA_CERT_EXPIRED) {
          await tx.auditLog.create({
            data: {
              action: AuditActions.INVOICE_CERT_EXPIRED,
              entityType: 'entry',
              entityId: entryId,
              actorUserId: user?.id ?? null,
              tenantId,
              severity: 'warn',
              metadata: {
                origin: 'operational_exit',
                plate: current.plate,
                cashSessionId: data.cashSessionId ?? current.cashSessionId,
                ticketNumber: current.ticketNumber,
                chargedAmount: roundMoney(computedAmount),
                invoiceId: createdInvoice.invoiceId,
                actorRole: actorRole(membership),
              },
            },
          });
        }
      }

      return tx.entry.findUniqueOrThrow({ where: { id: entryId } });
    });

    // Después del commit: ARCA puede tardar o estar caída y eso NUNCA puede
    // deshacer un cobro. `issueAfterClose` no tira.
    let invoice: CloseEntryResponseDto['invoice'] = null;
    if (this.invoices && createdInvoice) {
      const { invoiceId, issueNow } = createdInvoice as CreatedInvoice;
      invoice = issueNow
        ? await this.invoices.issueAfterClose(invoiceId, user?.id)
        : await this.invoices.summaryOrNull(invoiceId);
    }

    return { ...toDto(entry), invoice };
  }

  async correctEntry(
    entryId: string,
    expectedVersion: number,
    data: CorrectEntryDto,
    user: User,
    membership?: UserMembership | null,
  ): Promise<EntryDto> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const role = actorRole(membership);

    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await tx.entry.findFirst({
        where: { tenantId, id: entryId },
        include: { cashSession: true, paymentTransactions: true },
      });

      if (!current) {
        throw new FormattedException(
          'Not Found',
          HttpStatus.NOT_FOUND,
          `Entry ${entryId} not found in this entity.`,
          `/tenants/:tenantId/entries/${entryId}/correction`,
          ErrorCodes.NOT_FOUND,
        );
      }

      if (current.version !== expectedVersion) {
        throw new FormattedException(
          'Conflict',
          HttpStatus.CONFLICT,
          'Entry was changed by another write. Refresh and retry.',
          `/tenants/:tenantId/entries/${entryId}/correction`,
          ErrorCodes.CONFLICT,
        );
      }

      if (current.cashSession?.closedAt) {
        throw new FormattedException(
          'Conflict',
          HttpStatus.CONFLICT,
          'Entries from a closed cash session cannot be edited.',
          `/tenants/:tenantId/entries/${entryId}/correction`,
          ErrorCodes.ENTRY_CLOSED_SESSION_LOCKED,
        );
      }

      const isActive = current.leftAt === null;
      if (
        isActive &&
        (data.leftAt !== undefined || data.payments !== undefined)
      ) {
        throw new FormattedException(
          'Conflict',
          HttpStatus.CONFLICT,
          'Active entries cannot be corrected with exit time or payments.',
          `/tenants/:tenantId/entries/${entryId}/correction`,
          ErrorCodes.ENTRY_ACTIVE_PAYMENT_LOCKED,
        );
      }

      const before = snapshotEntry(current);
      const nextEnteredAt = data.enteredAt
        ? new Date(data.enteredAt)
        : current.enteredAt;
      const nextLeftAt =
        data.leftAt !== undefined ? new Date(data.leftAt) : current.leftAt;
      const nextPayments =
        data.payments !== undefined
          ? data.payments.map((payment) => ({
              id: payment.id,
              paymentMethodId: payment.paymentMethodId ?? null,
              paymentMethodName: payment.paymentMethodName,
              amount: payment.amount,
            }))
          : activePayments(current);
      const nextAmountPaid =
        data.payments !== undefined
          ? nextPayments.reduce((sum, payment) => sum + payment.amount, 0)
          : current.amountPaid;

      if (nextLeftAt && nextLeftAt.getTime() <= nextEnteredAt.getTime()) {
        throw new FormattedException(
          'Bad Request',
          HttpStatus.BAD_REQUEST,
          'Exit time must be after entry time.',
          `/tenants/:tenantId/entries/${entryId}/correction`,
          ErrorCodes.ENTRY_EXIT_NOT_AFTER_ENTRY,
        );
      }

      const timeChanged =
        nextEnteredAt.getTime() !== current.enteredAt.getTime() ||
        (nextLeftAt?.getTime() ?? null) !== (current.leftAt?.getTime() ?? null);
      const amountsChanged = hasPaymentAmountChange(
        activePayments(current),
        nextPayments,
      );
      // Una factura emitida no se edita: cambiar el monto dejaría el cobro y
      // el comprobante fiscal diciendo cosas distintas. Anularla es una nota
      // de crédito, que se hace desde ARCA (fuera del MVP).
      if (
        amountsChanged &&
        this.invoices &&
        (await this.invoices.hasIssuedInvoice(tx, tenantId, entryId))
      ) {
        throw new FormattedException(
          'Conflict',
          HttpStatus.CONFLICT,
          'The entry has an issued invoice: its amount cannot change.',
          `/tenants/:tenantId/entries/${entryId}/correction`,
          ErrorCodes.INVOICE_ALREADY_ISSUED,
        );
      }

      const reasonRequired =
        membership?.role === MembershipRole.operator &&
        (timeChanged || amountsChanged);
      if (reasonRequired && !data.reason?.trim()) {
        throw new FormattedException(
          'Bad Request',
          HttpStatus.BAD_REQUEST,
          'A reason is required to correct times or amounts as an operator.',
          `/tenants/:tenantId/entries/${entryId}/correction`,
          ErrorCodes.ENTRY_CORRECTION_REASON_REQUIRED,
        );
      }

      const updateData: Prisma.EntryUncheckedUpdateInput = {
        version: { increment: 1 },
      };
      if (data.plate !== undefined) updateData.plate = data.plate.toUpperCase();
      if (data.color !== undefined) updateData.color = data.color || null;
      if (data.cochera !== undefined) updateData.cochera = data.cochera || null;
      if (data.notes !== undefined) updateData.notes = data.notes || null;
      if (data.enteredAt !== undefined) updateData.enteredAt = nextEnteredAt;
      if (data.leftAt !== undefined) updateData.leftAt = nextLeftAt;
      if (data.vehicleBrand !== undefined) {
        updateData.vehicleBrand = data.vehicleBrand || null;
      }
      if (data.vehicleModel !== undefined) {
        updateData.vehicleModel = data.vehicleModel || null;
      }
      if (data.rateId !== undefined) updateData.rateId = data.rateId || null;
      if (data.rateSnapshotName !== undefined) {
        updateData.rateSnapshotName = data.rateSnapshotName || null;
      }
      if (data.rateSnapshotHourPriceArs !== undefined) {
        updateData.rateSnapshotHourPriceArs = data.rateSnapshotHourPriceArs;
      }
      if (data.rateSnapshotStayPriceArs !== undefined) {
        updateData.rateSnapshotStayPriceArs = data.rateSnapshotStayPriceArs;
      }
      if (data.rateSnapshotFractionPriceArs !== undefined) {
        updateData.rateSnapshotFractionPriceArs =
          data.rateSnapshotFractionPriceArs;
      }
      if (data.rateSnapshotMediaEstadiaPriceArs !== undefined) {
        updateData.rateSnapshotMediaEstadiaPriceArs =
          data.rateSnapshotMediaEstadiaPriceArs;
      }
      if (data.payments !== undefined) {
        updateData.amountPaid = nextAmountPaid;
      }

      await tx.entry.update({
        where: { id: entryId },
        data: updateData,
      });

      if (data.payments !== undefined) {
        const deletedAt = new Date();
        await (
          tx.paymentTransaction.updateMany as unknown as (args: {
            where: unknown;
            data: unknown;
          }) => Promise<unknown>
        )({
          where: {
            tenantId,
            entryId,
            deletedAt: null,
          },
          data: { deletedAt },
        });
        if (data.payments.length > 0) {
          const typeByLineId = await resolvePaymentLineTypes(
            tx,
            tenantId,
            data.payments,
          );

          await tx.paymentTransaction.createMany({
            data: data.payments.map((payment) => ({
              id: payment.id,
              tenantId,
              entryId,
              cashSessionId: current.cashSessionId,
              paymentMethodId: payment.paymentMethodId ?? null,
              paymentMethodName: payment.paymentMethodName,
              paymentMethodType: typeByLineId.get(payment.id)!,
              amount: payment.amount,
            })),
          });
        }
      }

      const after = await tx.entry.findUniqueOrThrow({
        where: { id: entryId },
        include: { cashSession: true, paymentTransactions: true },
      });
      const afterSnapshot = snapshotEntry(after);
      const changedFields = diffSnapshots(before, afterSnapshot);
      if (changedFields.length > 0) {
        const sensitive = changedFields.some((field) =>
          [
            'enteredAt',
            'leftAt',
            'amountPaid',
            'payments',
            'rateId',
            'rateSnapshotName',
            'rateSnapshotHourPriceArs',
            'rateSnapshotStayPriceArs',
            'rateSnapshotFractionPriceArs',
            'rateSnapshotMediaEstadiaPriceArs',
          ].includes(field),
        );
        await tx.auditLog.create({
          data: {
            action: AuditActions.ENTRY_CORRECTED,
            entityType: 'entry',
            entityId: entryId,
            actorUserId: user.id,
            tenantId,
            severity: sensitive ? 'warn' : 'info',
            metadata: {
              origin: 'history',
              before,
              after: afterSnapshot,
              changedFields,
              economicImpact: correctionEconomicImpact(before, afterSnapshot),
              reason: data.reason?.trim() || null,
              actorRole: role,
              cashSessionId: current.cashSessionId,
              ticketNumber: current.ticketNumber,
            },
          },
        });
      }

      if (!isActive && after.amountPaid !== null && after.leftAt !== null) {
        const suggestedAmount = calcSuggestedAmount({
          enteredAt: after.enteredAt,
          leftAt: after.leftAt,
          hourPrice: toNumber(after.rateSnapshotHourPriceArs),
          stayPrice: toNumber(after.rateSnapshotStayPriceArs),
          fractionPrice: toNumber(after.rateSnapshotFractionPriceArs),
          mediaEstadiaPrice: toNumber(after.rateSnapshotMediaEstadiaPriceArs),
        });
        const chargedAmount = Number(after.amountPaid);
        if (
          suggestedAmount > 0 &&
          chargedAmount < suggestedAmount * UNDERCHARGE_RATIO - MONEY_EPSILON
        ) {
          await tx.auditLog.create({
            data: {
              action: AuditActions.ENTRY_UNDERCHARGED,
              entityType: 'entry',
              entityId: entryId,
              actorUserId: user.id,
              tenantId,
              severity: 'warn',
              metadata: {
                origin: 'history',
                plate: after.plate,
                cashSessionId: after.cashSessionId,
                ticketNumber: after.ticketNumber,
                suggestedAmount: roundMoney(suggestedAmount),
                chargedAmount: roundMoney(chargedAmount),
                delta: roundMoney(suggestedAmount - chargedAmount),
                actorRole: role,
                reason: data.reason?.trim() || null,
              },
            },
          });
        }
      }

      return after;
    });

    return toDto(updated);
  }

  async createStayFromLprEvent(data: LprEntryDto): Promise<EntryDto> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const plate = data.plate.toUpperCase();
    const now = new Date();

    const entry = await this.prisma.$transaction(async (tx) => {
      // 1. Reject if an active stay for this plate already exists.
      const existing = await tx.entry.findFirst({
        where: { tenantId, plate, leftAt: null },
      });
      if (existing) {
        throw new FormattedException(
          'Duplicate active stay',
          HttpStatus.CONFLICT,
          `Plate ${plate} already has an active stay.`,
          `/tenants/${tenantId}/entries/lpr`,
          ErrorCodes.ENTRY_DUPLICATE_ACTIVE_STAY,
        );
      }

      // 2. Check whitelist — null result means no active authorization.
      const whitelistEntry = await tx.whitelist.findFirst({
        where: {
          tenantId,
          plate,
          OR: [{ validFrom: null }, { validFrom: { lte: now } }],
          AND: [{ OR: [{ validUntil: null }, { validUntil: { gte: now } }] }],
        },
      });

      // 3. Persist the stay. UUID is server-generated for LPR entries.
      return tx.entry.create({
        data: {
          id: crypto.randomUUID(),
          tenantId,
          plate,
          source: 'auto',
          vehicleType: data.vehicleType ?? null,
          entryImageUrl: data.imageUrl ?? null,
          entryCameraId: data.cameraId ?? null,
          enteredAt: data.timestamp ? new Date(data.timestamp) : now,
          whitelistId: whitelistEntry?.id ?? null,
        },
      });
    });

    return toDto(entry);
  }
}
