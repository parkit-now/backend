import { Prisma, ReservationStatus } from '@prisma/client';
import { AuditActions } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { EntriesService } from './entries.service';

/**
 * Ingreso y salida con reserva (fase 6): el vínculo al crear el ingreso, el
 * cierre que completa la reserva y el detector de subcobro que mide el
 * EXCEDENTE, no la estadía entera.
 */
const TENANT = '11111111-1111-7111-8111-111111111111';
const ENTRY = '22222222-2222-7222-8222-222222222222';
const RESERVATION = '0192aa00-0000-7000-8000-0000004f2k9a';
const OTHER_RESERVATION = '0192aa00-0000-7000-8000-000000000bbb';
const USER = { id: '33333333-3333-7333-8333-333333333333' };
const ENTRY_AT = new Date('2026-10-06T21:00:00.000Z');
const at = (minutes: number) => new Date(ENTRY_AT.getTime() + minutes * 60_000);

function reservationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RESERVATION,
    status: ReservationStatus.confirmed,
    vehiclePlate: 'AB123CD',
    vehicleCategory: 'car',
    entryAt: ENTRY_AT,
    exitAt: at(180),
    totalArs: new Prisma.Decimal(4500),
    paidAt: at(-600),
    policySnapshot: { earlyArrivalMinutes: 15, graceMinutes: 30 },
    user: { name: 'Lucía' },
    payments: [{ amountArs: new Prisma.Decimal(4500) }],
    ...overrides,
  };
}

function makeCreateService(rows: unknown[], claimed = 1) {
  const tx = {
    entry: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            ...data,
            updatedAt: new Date(),
            version: 1,
            syncSeq: 1,
          }),
        ),
    },
    vehicleType: { findFirst: jest.fn().mockResolvedValue(null) },
    whitelist: { findFirst: jest.fn().mockResolvedValue(null) },
    reservation: {
      findMany: jest.fn().mockResolvedValue(rows),
      updateMany: jest.fn().mockResolvedValue({ count: claimed }),
    },
  };
  const prisma = {
    $transaction: jest.fn((cb: (txArg: typeof tx) => unknown) => cb(tx)),
  };
  const subject = new EntriesService(
    prisma as unknown as PrismaService,
    { getTenantIdOrThrow: () => TENANT } as unknown as TenantContextService,
  );
  return { tx, subject };
}

const createdData = (tx: ReturnType<typeof makeCreateService>['tx']) =>
  (tx.entry.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;

describe('EntriesService · ingreso con reserva', () => {
  it('con el reservationId del banner: vincula, pasa a checked_in y guarda el prepago', async () => {
    const { tx, subject } = makeCreateService([reservationRow()]);

    const dto = await subject.createEntry({
      id: ENTRY,
      plate: 'ab123cd',
      enteredAt: at(-8).toISOString(),
      reservationId: RESERVATION,
    });

    expect(tx.reservation.updateMany).toHaveBeenCalledWith({
      where: {
        id: RESERVATION,
        tenantId: TENANT,
        status: ReservationStatus.confirmed,
      },
      data: { status: ReservationStatus.checked_in },
    });
    expect(createdData(tx)).toMatchObject({
      reservationId: RESERVATION,
      prepaidAmountArs: 4500,
    });
    expect(dto).toMatchObject({
      reservationId: RESERVATION,
      prepaidAmountArs: 4500,
    });
  });

  it('sin reservationId (caja offline o vieja): vincula igual por patente', async () => {
    const { tx, subject } = makeCreateService([reservationRow()]);

    await subject.createEntry({
      id: ENTRY,
      plate: 'AB123CD',
      enteredAt: at(5).toISOString(),
    });

    expect(createdData(tx)).toMatchObject({ reservationId: RESERVATION });
  });

  it('ingreso offline sincronizado después del no_show: vale el enteredAt original', async () => {
    const { tx, subject } = makeCreateService([
      reservationRow({ status: ReservationStatus.no_show }),
    ]);

    await subject.createEntry({
      id: ENTRY,
      plate: 'AB123CD',
      enteredAt: at(-3).toISOString(),
    });

    expect(tx.reservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: ReservationStatus.no_show,
        }) as unknown,
      }),
    );
    expect(createdData(tx)).toMatchObject({ reservationId: RESERVATION });
  });

  it('fuera de la ventana no vincula ni toca la reserva', async () => {
    const { tx, subject } = makeCreateService([reservationRow()]);

    const dto = await subject.createEntry({
      id: ENTRY,
      plate: 'AB123CD',
      enteredAt: at(45).toISOString(),
      reservationId: RESERVATION,
    });

    expect(tx.reservation.updateMany).not.toHaveBeenCalled();
    expect(dto).toMatchObject({ reservationId: null, prepaidAmountArs: null });
  });

  it('un reservationId que ya no vale (otra reserva, carrera perdida) no rechaza el ingreso', async () => {
    const { tx, subject } = makeCreateService([reservationRow()], 0);

    const dto = await subject.createEntry({
      id: ENTRY,
      plate: 'AB123CD',
      enteredAt: at(0).toISOString(),
      reservationId: OTHER_RESERVATION,
    });

    expect(tx.entry.create).toHaveBeenCalledTimes(1);
    expect(dto.reservationId).toBeNull();
  });

  it('LPR: el check-in por cámara también vincula', async () => {
    const { tx, subject } = makeCreateService([reservationRow()]);

    await subject.createStayFromLprEvent({
      plate: 'AB123CD',
      timestamp: at(-2).toISOString(),
    });

    expect(createdData(tx)).toMatchObject({
      source: 'auto',
      reservationId: RESERVATION,
      prepaidAmountArs: 4500,
    });
  });
});

describe('EntriesService · salida con reserva', () => {
  // Tarifa $1.500/h y $125 la fracción: 3 h 48 min = $5.750.
  const current = {
    id: ENTRY,
    tenantId: TENANT,
    plate: 'AB123CD',
    enteredAt: at(-8),
    leftAt: null,
    amountPaid: null,
    rateId: null,
    rateSnapshotName: 'Auto',
    rateSnapshotHourPriceArs: 1500,
    rateSnapshotStayPriceArs: 0,
    rateSnapshotFractionPriceArs: 125,
    rateSnapshotMediaEstadiaPriceArs: null,
    cashSessionId: '55555555-5555-7555-8555-555555555555',
    ticketNumber: 7,
    reservationId: RESERVATION,
    prepaidAmountArs: new Prisma.Decimal(4500),
  };
  const leftAt = new Date(at(-8).getTime() + 228 * 60_000);

  function makeCloseService() {
    const tx = {
      entry: {
        findFirst: jest.fn().mockResolvedValue(current),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ ...current, leftAt }),
      },
      reservation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      paymentTransaction: { createMany: jest.fn() },
      paymentMethod: { findMany: jest.fn().mockResolvedValue([]) },
      cashSession: { findFirst: jest.fn().mockResolvedValue(null) },
      auditLog: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((cb: (txArg: typeof tx) => unknown) => cb(tx)),
    };
    const subject = new EntriesService(
      prisma as unknown as PrismaService,
      { getTenantIdOrThrow: () => TENANT } as unknown as TenantContextService,
    );
    return { tx, subject };
  }

  it('cerrar la estadía completa la reserva (checked_in → completed)', async () => {
    const { tx, subject } = makeCloseService();

    await subject.closeEntry(
      ENTRY,
      1,
      { leftAt: leftAt.toISOString(), amountPaid: 1250 },
      USER as never,
      { role: 'operator' } as never,
    );

    expect(tx.reservation.updateMany).toHaveBeenCalledWith({
      where: {
        id: RESERVATION,
        tenantId: TENANT,
        status: ReservationStatus.checked_in,
      },
      data: { status: ReservationStatus.completed },
    });
  });

  it('cobrar sólo el excedente NO es subcobro', async () => {
    const { tx, subject } = makeCloseService();

    await subject.closeEntry(
      ENTRY,
      1,
      { leftAt: leftAt.toISOString(), amountPaid: 1250 },
      USER as never,
      { role: 'operator' } as never,
    );

    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('cobrar menos que el excedente sí es subcobro, medido contra el excedente', async () => {
    const { tx, subject } = makeCloseService();

    await subject.closeEntry(
      ENTRY,
      1,
      { leftAt: leftAt.toISOString(), amountPaid: 500 },
      USER as never,
      { role: 'operator' } as never,
    );

    const audit = tx.auditLog.create.mock.calls[0][0] as {
      data: {
        action: string;
        metadata: { suggestedAmount: number; prepaidAmount: number };
      };
    };
    expect(audit.data.action).toBe(AuditActions.ENTRY_UNDERCHARGED);
    expect(audit.data.metadata.suggestedAmount).toBe(1250);
    expect(audit.data.metadata.prepaidAmount).toBe(4500);
  });

  it('un ingreso sin reserva no toca reservas al cerrar', async () => {
    const { tx, subject } = makeCloseService();
    tx.entry.findFirst.mockResolvedValue({
      ...current,
      reservationId: null,
      prepaidAmountArs: null,
    });

    await subject.closeEntry(
      ENTRY,
      1,
      { leftAt: leftAt.toISOString(), amountPaid: 5750 },
      USER as never,
      { role: 'operator' } as never,
    );

    expect(tx.reservation.updateMany).not.toHaveBeenCalled();
  });
});
