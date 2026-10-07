import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { CashSessionChangesQueryDto } from './dto/cash-session-changes-query.dto';
import { CashSessionDto } from './dto/cash-session.dto';
import { CloseCashSessionDto } from './dto/close-cash-session.dto';
import { CloseCashSessionResponseDto } from './dto/close-cash-session-response.dto';
import { CreateCashSessionDto } from './dto/create-cash-session.dto';
import { ListCashSessionsQueryDto } from './dto/list-cash-sessions-query.dto';
import { UpdateCashSessionDto } from './dto/update-cash-session.dto';

type PrismaCashSession = Prisma.CashSessionGetPayload<Record<string, never>>;

function toDto(s: PrismaCashSession): CashSessionDto {
  return {
    id: s.id,
    tenantId: s.tenantId,
    openedAt: s.openedAt,
    closedAt: s.closedAt,
    openingCash: Number(s.openingCash),
    leavingCash: s.leavingCash !== null ? Number(s.leavingCash) : null,
    notes: s.notes,
    version: s.version,
    syncSeq: s.syncSeq,
    updatedAt: s.updatedAt,
  };
}

@Injectable()
export class CashSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async createSession(data: CreateCashSessionDto): Promise<CashSessionDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    const existing = await tenantPrisma.cashSession.findFirst({
      where: { tenantId, closedAt: null },
    });
    if (existing) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        'There is already an open cash session for this tenant.',
        '/tenants/:tenantId/cash-sessions',
        ErrorCodes.CONFLICT,
      );
    }

    const session = await tenantPrisma.cashSession.create({
      data: {
        id: data.id,
        openedAt: new Date(data.openedAt),
        openingCash: data.openingCash ?? 0,
      } as Prisma.CashSessionUncheckedCreateInput,
    });
    return toDto(session);
  }

  async getActiveSession(): Promise<CashSessionDto | null> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const session = await tenantPrisma.cashSession.findFirst({
      where: { tenantId, closedAt: null },
    });
    return session ? toDto(session) : null;
  }

  /**
   * Shifts, most recent first, optionally only those overlapping `[from, to)`.
   *
   * Overlap rather than containment: a shift that opened before `from` but was
   * still running then belongs to the window. `closedAt` is compared strictly
   * for the same reason `to` is exclusive — a shift that closed exactly at
   * `from` did not run inside it.
   */
  async listSessions(
    query: ListCashSessionsQueryDto,
  ): Promise<CashSessionDto[]> {
    const tenantPrisma = this.prisma.getTenantClient();
    const from = query.from !== undefined ? new Date(query.from) : undefined;
    const to = query.to !== undefined ? new Date(query.to) : undefined;

    if (from && to && from >= to) {
      throw new FormattedException(
        'Bad Request',
        HttpStatus.BAD_REQUEST,
        '`from` must be earlier than `to`.',
        '/tenants/:tenantId/cash-sessions',
        ErrorCodes.VALIDATION_FAILED,
      );
    }

    const sessions = await tenantPrisma.cashSession.findMany({
      where: {
        ...(to ? { openedAt: { lt: to } } : {}),
        ...(from
          ? { OR: [{ closedAt: null }, { closedAt: { gt: from } }] }
          : {}),
      },
      orderBy: [{ openedAt: 'desc' }],
      take: query.limit,
    });
    return sessions.map(toDto);
  }

  async pullChanges(
    query: CashSessionChangesQueryDto,
  ): Promise<{ items: CashSessionDto[]; maxSeq: number }> {
    const tenantPrisma = this.prisma.getTenantClient();
    const items = await tenantPrisma.cashSession.findMany({
      where: { syncSeq: { gt: query.afterSeq } },
      orderBy: [{ syncSeq: 'asc' }],
      take: query.limit,
    });
    const maxSeq =
      items.length > 0 ? items[items.length - 1].syncSeq : query.afterSeq;
    return { items: items.map(toDto), maxSeq };
  }

  async updateSession(
    sessionId: string,
    expectedVersion: number,
    data: UpdateCashSessionDto,
  ): Promise<CashSessionDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const instance = `/tenants/${tenantId}/cash-sessions/${sessionId}`;

    // `version: { increment: 1 }` no es redundante: el trigger de sync sólo
    // toca updated_at y sync_seq. La app es lo único que bumpea la versión.
    const updateData: Prisma.CashSessionUpdateManyMutationInput = {
      version: { increment: 1 },
    };
    if (data.notes !== undefined) updateData.notes = data.notes;

    const result = await tenantPrisma.cashSession.updateMany({
      where: { id: sessionId, tenantId, version: expectedVersion },
      data: updateData,
    });

    if (result.count === 0) {
      const existing = await tenantPrisma.cashSession.findFirst({
        where: { id: sessionId, tenantId },
      });
      if (!existing) {
        throw new FormattedException(
          'Not Found',
          HttpStatus.NOT_FOUND,
          'Cash session not found.',
          instance,
          ErrorCodes.NOT_FOUND,
        );
      }
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        'Cash session was changed by another write. Refresh and retry.',
        instance,
        ErrorCodes.CONFLICT,
      );
    }

    return toDto(
      await tenantPrisma.cashSession.findUniqueOrThrow({
        where: { id: sessionId },
      }),
    );
  }

  async closeSession(
    sessionId: string,
    data: CloseCashSessionDto,
  ): Promise<CloseCashSessionResponseDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    const existing = await tenantPrisma.cashSession.findFirst({
      where: { tenantId, id: sessionId, closedAt: null },
    });
    if (!existing) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        'Cash session not found or already closed.',
        `/tenants/:tenantId/cash-sessions/${sessionId}/close`,
        ErrorCodes.NOT_FOUND,
      );
    }

    const closedAt = data.closedAt ? new Date(data.closedAt) : new Date();
    const openNextSession = data.openNextSession === true;
    const leavingCash = openNextSession ? (data.leavingCash ?? 0) : 0;

    // Run everything in a single transaction:
    // 1. Close the current session
    // 2. Optionally open the new session with opening_cash = leaving_cash
    // 3. Reassign active entries to that new session, or detach them until a
    //    later session exists for their eventual exit payment.
    // Note: $transaction provides a raw PrismaClient — tenant scoping via
    // explicit tenantId filters since the extension wrapper is not active.
    const result = await this.prisma.$transaction(async (tx) => {
      const closed = await tx.cashSession.update({
        where: { id: sessionId, tenantId },
        data: {
          closedAt,
          leavingCash,
          notes: data.notes,
        },
      });

      // Find active entries (still in the lot) sorted by enteredAt for renumbering
      const activeEntries = await tx.entry.findMany({
        where: {
          tenantId,
          cashSessionId: sessionId,
          leftAt: null,
          deletedAt: null,
        },
        orderBy: [{ enteredAt: 'asc' }],
        select: { id: true },
      });

      if (!openNextSession) {
        if (activeEntries.length > 0) {
          await tx.entry.updateMany({
            where: {
              tenantId,
              cashSessionId: sessionId,
              leftAt: null,
              deletedAt: null,
            },
            data: { cashSessionId: null, ticketNumber: null },
          });
        }
        return { closed, newSession: null, carriedOverCount: 0 };
      }

      const newSession = await tx.cashSession.create({
        data: {
          id: data.newSessionId!,
          tenantId,
          openedAt: closedAt,
          openingCash: leavingCash,
        },
      });

      // Reassign and renumber each carried-over entry
      for (let i = 0; i < activeEntries.length; i++) {
        await tx.entry.update({
          where: { id: activeEntries[i].id, tenantId },
          data: {
            cashSessionId: newSession.id,
            ticketNumber: i + 1,
          },
        });
      }

      return { closed, newSession, carriedOverCount: activeEntries.length };
    });

    return {
      closedSession: toDto(result.closed),
      newSession: result.newSession ? toDto(result.newSession) : null,
      carriedOverCount: result.carriedOverCount,
    };
  }
}
