import { HttpStatus, Injectable } from '@nestjs/common';
import { MembershipRole, Prisma } from '@prisma/client';
import type { User, UserMembership } from '@prisma/client';
import { AuditActions } from '../audit/audit.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { CloseEntryDto } from './dto/close-entry.dto';
import { CorrectEntryDto } from './dto/correct-entry.dto';
import { CreateEntryDto } from './dto/create-entry.dto';
import { EntryChangesQueryDto } from './dto/entry-changes-query.dto';
import { EntryDto } from './dto/entry.dto';
import { LprEntryDto } from './dto/lpr-entry.dto';

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
  cashSessionId: string | null;
  ticketNumber: number | null;
  payments: PaymentSnapshot[];
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

function calcSuggestedAmount(input: {
  enteredAt: Date;
  leftAt: Date;
  hourPrice: number | null;
  stayPrice: number | null;
  fractionPrice: number | null;
}): number {
  const hourPrice = input.hourPrice ?? 0;
  const stayPrice = input.stayPrice ?? 0;
  const fractionPrice = input.fractionPrice ?? 0;
  const totalMinutes =
    (input.leftAt.getTime() - input.enteredAt.getTime()) / 60000;

  if (totalMinutes <= 0) return 0;

  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  const fullHoursAmount = hours * hourPrice;
  const fractionAmount = remainingMinutes > 0 ? fractionPrice : 0;
  return Math.min(fullHoursAmount + fractionAmount, stayPrice);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function moneyEqual(
  left: number | null | undefined,
  right: number | null | undefined,
): boolean {
  return Math.abs((left ?? 0) - (right ?? 0)) <= MONEY_EPSILON;
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
  ): Promise<EntryDto> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const leftAt = data.leftAt ? new Date(data.leftAt) : new Date();

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

      // Create payment transaction records if payments were provided.
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

        await tx.paymentTransaction.createMany({
          data: data.payments.map((p) => ({
            id: p.id,
            tenantId,
            entryId,
            cashSessionId,
            paymentMethodId: p.paymentMethodId ?? null,
            paymentMethodName: p.paymentMethodName,
            amount: p.amount,
          })),
        });
      }

      if (computedAmount !== undefined) {
        const suggestedAmount = calcSuggestedAmount({
          enteredAt: current.enteredAt,
          leftAt,
          hourPrice: toNumber(current.rateSnapshotHourPriceArs),
          stayPrice: toNumber(current.rateSnapshotStayPriceArs),
          fractionPrice: toNumber(current.rateSnapshotFractionPriceArs),
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
                },
              },
            },
          });
        }
      }

      return tx.entry.findUniqueOrThrow({ where: { id: entryId } });
    });

    return toDto(entry);
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

      if (nextLeftAt && nextLeftAt.getTime() < nextEnteredAt.getTime()) {
        throw new FormattedException(
          'Bad Request',
          HttpStatus.BAD_REQUEST,
          'Exit time cannot be before entry time.',
          `/tenants/:tenantId/entries/${entryId}/correction`,
          ErrorCodes.BAD_REQUEST,
        );
      }

      const timeChanged =
        nextEnteredAt.getTime() !== current.enteredAt.getTime() ||
        (nextLeftAt?.getTime() ?? null) !== (current.leftAt?.getTime() ?? null);
      const amountsChanged = hasPaymentAmountChange(
        activePayments(current),
        nextPayments,
      );
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

      const rateOrTimeChanged =
        timeChanged ||
        (data.rateId !== undefined &&
          (data.rateId || null) !== current.rateId) ||
        (data.rateSnapshotName !== undefined &&
          (data.rateSnapshotName || null) !== current.rateSnapshotName) ||
        (data.rateSnapshotHourPriceArs !== undefined &&
          !moneyEqual(
            data.rateSnapshotHourPriceArs,
            toNumber(current.rateSnapshotHourPriceArs),
          )) ||
        (data.rateSnapshotStayPriceArs !== undefined &&
          !moneyEqual(
            data.rateSnapshotStayPriceArs,
            toNumber(current.rateSnapshotStayPriceArs),
          )) ||
        (data.rateSnapshotFractionPriceArs !== undefined &&
          !moneyEqual(
            data.rateSnapshotFractionPriceArs,
            toNumber(current.rateSnapshotFractionPriceArs),
          ));
      if (!isActive && rateOrTimeChanged && data.payments === undefined) {
        throw new FormattedException(
          'Bad Request',
          HttpStatus.BAD_REQUEST,
          'Payment lines are required when correcting rate or times on a closed entry.',
          `/tenants/:tenantId/entries/${entryId}/correction`,
          ErrorCodes.BAD_REQUEST,
        );
      }
      if (!isActive && rateOrTimeChanged && nextLeftAt) {
        const suggestedAmount = calcSuggestedAmount({
          enteredAt: nextEnteredAt,
          leftAt: nextLeftAt,
          hourPrice:
            data.rateSnapshotHourPriceArs ??
            toNumber(current.rateSnapshotHourPriceArs),
          stayPrice:
            data.rateSnapshotStayPriceArs ??
            toNumber(current.rateSnapshotStayPriceArs),
          fractionPrice:
            data.rateSnapshotFractionPriceArs ??
            toNumber(current.rateSnapshotFractionPriceArs),
        });
        const paymentTotal = nextPayments.reduce(
          (sum, payment) => sum + payment.amount,
          0,
        );
        if (Math.abs(paymentTotal - suggestedAmount) > MONEY_EPSILON) {
          throw new FormattedException(
            'Bad Request',
            HttpStatus.BAD_REQUEST,
            'Payment total must match the suggested amount when correcting rate or times.',
            `/tenants/:tenantId/entries/${entryId}/correction`,
            ErrorCodes.BAD_REQUEST,
          );
        }
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
          await tx.paymentTransaction.createMany({
            data: data.payments.map((payment) => ({
              id: payment.id,
              tenantId,
              entryId,
              cashSessionId: current.cashSessionId,
              paymentMethodId: payment.paymentMethodId ?? null,
              paymentMethodName: payment.paymentMethodName,
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
