import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, ScheduleDay } from '@prisma/client';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { ListSchedulesQueryDto } from './dto/list-schedules-query.dto';
import { ScheduleChangesQueryDto } from './dto/schedule-changes-query.dto';
import { ScheduleDto } from './dto/schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';

type PrismaSchedule = Prisma.ScheduleGetPayload<Record<string, never>>;

function toDto(schedule: PrismaSchedule): ScheduleDto {
  return { ...schedule };
}

type ScheduleChangesResponse = {
  items: ScheduleDto[];
  maxSeq: number;
};

@Injectable()
export class SchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async listSchedules(query: ListSchedulesQueryDto): Promise<ScheduleDto[]> {
    const tenantPrisma = this.prisma.getTenantClient();
    const where: Prisma.ScheduleWhereInput = {};
    if (query.day) where.day = query.day;

    const schedules = await tenantPrisma.schedule.findMany({
      where,
      orderBy: [{ day: 'asc' }, { openMinute: 'asc' }],
    });
    return schedules.map(toDto);
  }

  async pullChanges(
    query: ScheduleChangesQueryDto,
  ): Promise<ScheduleChangesResponse> {
    const tenantPrisma = this.prisma.getTenantClient();

    const items = await tenantPrisma.schedule.findMany({
      where: { syncSeq: { gt: query.afterSeq } },
      orderBy: [{ syncSeq: 'asc' }],
      take: query.limit,
    });

    const maxSeq =
      items.length > 0 ? items[items.length - 1].syncSeq : query.afterSeq;
    return { items: items.map(toDto), maxSeq };
  }

  async createSchedule(data: CreateScheduleDto): Promise<ScheduleDto> {
    this.assertValidRange(data.openMinute, data.closeMinute);
    await this.assertNoOverlap(data.day, data.openMinute, data.closeMinute);

    const tenantPrisma = this.prisma.getTenantClient();
    const schedule = await tenantPrisma.schedule.create({
      data: {
        day: data.day,
        openMinute: data.openMinute,
        closeMinute: data.closeMinute,
        // tenantId is injected by prismaForTenant(...)
      } as Prisma.ScheduleUncheckedCreateInput,
    });
    return toDto(schedule);
  }

  async updateSchedule(
    scheduleId: string,
    expectedVersion: number,
    data: UpdateScheduleDto,
  ): Promise<ScheduleDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    const current = await tenantPrisma.schedule.findUnique({
      where: { id: scheduleId },
    });
    if (!current) {
      throw this.notFound(scheduleId);
    }

    const day = data.day ?? current.day;
    const openMinute = data.openMinute ?? current.openMinute;
    const closeMinute = data.closeMinute ?? current.closeMinute;

    this.assertValidRange(openMinute, closeMinute);
    await this.assertNoOverlap(day, openMinute, closeMinute, scheduleId);

    const result = await tenantPrisma.schedule.updateMany({
      where: { tenantId, id: scheduleId, version: expectedVersion },
      data: {
        day,
        openMinute,
        closeMinute,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      throw this.conflict(scheduleId);
    }

    return toDto(
      await tenantPrisma.schedule.findUniqueOrThrow({
        where: { id: scheduleId },
      }),
    );
  }

  async deleteSchedule(
    scheduleId: string,
    expectedVersion: number,
  ): Promise<void> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    const result = await tenantPrisma.schedule.deleteMany({
      where: { tenantId, id: scheduleId, version: expectedVersion },
    });

    if (result.count === 0) {
      throw this.conflict(scheduleId);
    }
  }

  private assertValidRange(openMinute: number, closeMinute: number): void {
    if (closeMinute <= openMinute) {
      throw new FormattedException(
        'Invalid schedule range',
        HttpStatus.BAD_REQUEST,
        'closeMinute must be greater than openMinute.',
        '/tenants/:tenantId/schedules',
        ErrorCodes.SCHEDULE_INVALID_RANGE,
      );
    }
  }

  /**
   * Rejects ranges that intersect an existing range on the same weekday.
   * Ranges are half-open [open, close): touching at an edge is allowed
   * (e.g. 08:00–12:00 and 12:00–20:00 do not overlap).
   */
  private async assertNoOverlap(
    day: ScheduleDay,
    openMinute: number,
    closeMinute: number,
    excludeId?: string,
  ): Promise<void> {
    const tenantPrisma = this.prisma.getTenantClient();

    const overlap = await tenantPrisma.schedule.findFirst({
      where: {
        day,
        ...(excludeId ? { id: { not: excludeId } } : {}),
        openMinute: { lt: closeMinute },
        closeMinute: { gt: openMinute },
      },
    });

    if (overlap) {
      throw new FormattedException(
        'Schedule overlap',
        HttpStatus.CONFLICT,
        'The opening range overlaps another range on the same day.',
        '/tenants/:tenantId/schedules',
        ErrorCodes.SCHEDULE_OVERLAP,
      );
    }
  }

  private notFound(scheduleId: string): FormattedException {
    return new FormattedException(
      'Not found',
      HttpStatus.NOT_FOUND,
      `Schedule ${scheduleId} was not found in the active tenant.`,
      `/tenants/:tenantId/schedules/${scheduleId}`,
      ErrorCodes.SCHEDULE_NOT_FOUND,
    );
  }

  private conflict(scheduleId: string): FormattedException {
    return new FormattedException(
      'Conflict',
      HttpStatus.CONFLICT,
      'Schedule was changed by another write. Refresh and retry with the latest version.',
      `/tenants/:tenantId/schedules/${scheduleId}`,
      ErrorCodes.CONFLICT,
    );
  }
}
