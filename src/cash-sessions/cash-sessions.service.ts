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

  async listSessions(): Promise<CashSessionDto[]> {
    const tenantPrisma = this.prisma.getTenantClient();
    const sessions = await tenantPrisma.cashSession.findMany({
      orderBy: [{ openedAt: 'desc' }],
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
    const leavingCash = data.leavingCash ?? 0;

    // Run everything in a single transaction:
    // 1. Close the current session
    // 2. Open the new session with opening_cash = leaving_cash
    // 3. Carry over active entries (reassign + renumber)
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

      const newSession = await tx.cashSession.create({
        data: {
          id: data.newSessionId,
          tenantId,
          openedAt: closedAt,
          openingCash: leavingCash,
        },
      });

      // Find active entries (still in the lot) sorted by enteredAt for renumbering
      const activeEntries = await tx.entry.findMany({
        where: { tenantId, cashSessionId: sessionId, leftAt: null },
        orderBy: [{ enteredAt: 'asc' }],
        select: { id: true },
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
      newSession: toDto(result.newSession),
      carriedOverCount: result.carriedOverCount,
    };
  }
}
