import { Prisma, ReservationStatus } from '@prisma/client';
import {
  arrivalSearchRange,
  arrivalWindow,
  claimReservationForArrival,
  classifyArrival,
  completeReservationForExit,
  fallbackEarlyArrivalMax,
  findUpcomingReservation,
  isWithinArrivalWindow,
  linkableWindow,
  pickReservationForArrival,
  prepaidAmountOf,
  reservationCode,
  stayArrival,
  type ArrivalClass,
} from './reservation-checkin';

const TENANT = '11111111-1111-7111-8111-111111111111';
const ENTRY_AT = new Date('2026-10-06T21:00:00.000Z'); // 18:00 en Buenos Aires
const at = (minutesFromEntry: number) =>
  new Date(ENTRY_AT.getTime() + minutesFromEntry * 60_000);
// Política de la reserva: llega hasta 15' antes, tolerancia de 30' y se
// vincula desde 60' antes (tope de llegada anticipada). La franja es de 3 h.
const POLICY = {
  earlyArrivalMinutes: 15,
  graceMinutes: 30,
  earlyArrivalMaxMinutes: 60,
};

function candidate(
  overrides: Partial<{
    id: string;
    status: ReservationStatus;
    entryAt: Date;
    exitAt: Date;
    policySnapshot: unknown;
  }> = {},
) {
  return {
    id: 'r-1',
    status: ReservationStatus.confirmed,
    entryAt: ENTRY_AT,
    exitAt: at(180),
    policySnapshot: POLICY,
    ...overrides,
  };
}

describe('ventana de llegada', () => {
  it('es [entryAt − llegada anticipada, entryAt + tolerancia] de la foto de la reserva', () => {
    expect(arrivalWindow(candidate())).toEqual({
      from: at(-15),
      until: at(30),
    });
  });

  it('sin foto (reservas viejas) usa los defaults: 15 antes y 30 después', () => {
    expect(arrivalWindow(candidate({ policySnapshot: null }))).toEqual({
      from: at(-15),
      until: at(30),
    });
  });

  it.each([
    [-16, false],
    [-15, true],
    [0, true],
    [30, true],
    [31, false],
  ])('llegar %i min respecto del inicio → %s', (minutes, expected) => {
    expect(isWithinArrivalWindow(candidate(), at(minutes))).toBe(expected);
  });

  it('el rango de búsqueda cubre el tope más amplio posible (1440 antes) y las franjas que siguen abiertas', () => {
    expect(arrivalSearchRange(ENTRY_AT)).toEqual({
      entryAt: { lte: at(1440) },
      OR: [{ exitAt: { gte: ENTRY_AT } }, { entryAt: { gte: at(-180) } }],
    });
  });
});

describe('rangos de llegada (6c)', () => {
  it.each([
    [-61, 'too_early', 61, 0],
    [-60, 'early', 60, 0],
    [-50, 'early', 50, 0],
    [-16, 'early', 16, 0],
    [-15, 'on_time', 15, 0],
    [0, 'on_time', 0, 0],
    [30, 'on_time', 0, 30],
    [31, 'late', 0, 31],
    [180, 'late', 0, 180],
    [181, 'too_late', 0, 181],
  ])(
    'llegar %i min respecto del inicio → %s',
    (minutes, arrival, minutesEarly, minutesLate) => {
      expect(classifyArrival(candidate(), at(minutes))).toEqual({
        arrival: arrival as ArrivalClass,
        minutesEarly,
        minutesLate,
      });
    },
  );

  it('el rango vinculable va del tope a exitAt', () => {
    expect(linkableWindow(candidate())).toEqual({
      from: at(-60),
      until: at(180),
    });
  });

  it('una reserva corta no corta la tolerancia: el rango llega al menos al fin de la ventana', () => {
    expect(linkableWindow(candidate({ exitAt: at(20) })).until).toEqual(at(30));
  });

  it('el tope nunca es menor que la llegada anticipada normal', () => {
    const wide = candidate({
      policySnapshot: {
        earlyArrivalMinutes: 90,
        graceMinutes: 30,
        earlyArrivalMaxMinutes: 60,
      },
    });
    expect(classifyArrival(wide, at(-80)).arrival).toBe('on_time');
    expect(classifyArrival(wide, at(-91)).arrival).toBe('too_early');
  });

  it('tope 0: sólo la ventana normal vincula', () => {
    const strict = candidate({
      policySnapshot: { ...POLICY, earlyArrivalMaxMinutes: 0 },
    });
    expect(classifyArrival(strict, at(-16)).arrival).toBe('too_early');
    expect(classifyArrival(strict, at(-15)).arrival).toBe('on_time');
  });

  it('una reserva sin tope en la foto (anterior a la 6c) usa el del servicio', () => {
    const legacy = candidate({
      policySnapshot: { earlyArrivalMinutes: 15, graceMinutes: 30 },
    });
    expect(classifyArrival(legacy, at(-50), 45).arrival).toBe('too_early');
    expect(classifyArrival(legacy, at(-50), 120).arrival).toBe('early');
    // La foto gana sobre el valor vivo.
    expect(classifyArrival(candidate(), at(-50), 10).arrival).toBe('early');
  });

  it('stayArrival marca cómo entró un auto ya vinculado', () => {
    expect(stayArrival(candidate(), at(-50))).toEqual({
      arrival: 'early',
      minutesEarly: 50,
      minutesLate: 0,
    });
    expect(stayArrival(candidate(), at(-5)).arrival).toBe('on_time');
    expect(stayArrival(candidate(), at(45))).toEqual({
      arrival: 'late',
      minutesEarly: 0,
      minutesLate: 45,
    });
  });
});

describe('pickReservationForArrival', () => {
  it('elige la reserva dentro de la ventana', () => {
    expect(pickReservationForArrival([candidate()], at(-8))?.id).toBe('r-1');
  });

  it('antes del tope o pasada la franja no hay reserva', () => {
    expect(pickReservationForArrival([candidate()], at(-61))).toBeNull();
    expect(pickReservationForArrival([candidate()], at(181))).toBeNull();
  });

  it('una llegada anticipada dentro del tope se vincula y queda marcada', () => {
    const picked = pickReservationForArrival([candidate()], at(-50));
    expect(picked?.classification).toEqual({
      arrival: 'early',
      minutesEarly: 50,
      minutesLate: 0,
    });
  });

  it('una llegada tarde antes de exitAt se vincula, también si ya era no_show', () => {
    const picked = pickReservationForArrival(
      [candidate({ status: ReservationStatus.no_show })],
      at(45),
    );
    expect(picked?.classification.arrival).toBe('late');
    expect(picked?.status).toBe(ReservationStatus.no_show);
  });

  it('entre una tardía y una a tiempo gana la que llega a tiempo', () => {
    const morning = candidate({
      id: 'r-morning',
      entryAt: at(-150),
      exitAt: at(10),
    });
    const evening = candidate({ id: 'r-evening', entryAt: at(10) });
    expect(pickReservationForArrival([morning, evening], at(0))?.id).toBe(
      'r-evening',
    );
  });

  it('una reserva ya usada (checked_in, completed) no se vuelve a tomar: idempotente', () => {
    for (const status of [
      ReservationStatus.checked_in,
      ReservationStatus.completed,
      ReservationStatus.cancelled,
      ReservationStatus.pending_approval,
    ]) {
      expect(pickReservationForArrival([candidate({ status })], at(0))).toBe(
        null,
      );
    }
  });

  it('una no_show dentro de su ventana se vincula (ingreso offline que llegó tarde al servidor)', () => {
    const picked = pickReservationForArrival(
      [candidate({ status: ReservationStatus.no_show })],
      at(5),
    );
    expect(picked?.status).toBe(ReservationStatus.no_show);
  });

  it('con dos reservas de la misma patente gana la de inicio más cercano', () => {
    const morning = candidate({
      id: 'r-morning',
      entryAt: at(-120),
      policySnapshot: { earlyArrivalMinutes: 15, graceMinutes: 180 },
    });
    const evening = candidate({ id: 'r-evening' });
    expect(pickReservationForArrival([morning, evening], at(-5))?.id).toBe(
      'r-evening',
    );
  });

  it('la que eligió la caja gana si sigue siendo válida; si no, se busca igual', () => {
    const first = candidate({ id: 'r-a' });
    const second = candidate({ id: 'r-b', entryAt: at(10) });
    expect(pickReservationForArrival([first, second], at(0), 'r-b')?.id).toBe(
      'r-b',
    );
    expect(
      pickReservationForArrival([first, second], at(0), 'r-otra')?.id,
    ).toBe('r-a');
  });
});

describe('prepaidAmountOf', () => {
  it('es la suma de los pagos aprobados', () => {
    expect(
      prepaidAmountOf({
        totalArs: new Prisma.Decimal(4500),
        paidAt: new Date(),
        payments: [{ amountArs: new Prisma.Decimal('4500.00') }],
      }),
    ).toBe(4500);
  });

  it('sin fila de pago pero pagada: el total', () => {
    expect(
      prepaidAmountOf({ totalArs: 4500, paidAt: new Date(), payments: [] }),
    ).toBe(4500);
  });

  it('el camino viejo sin pago (fuera de producción): 0, se cobra todo en la caja', () => {
    expect(
      prepaidAmountOf({ totalArs: 4500, paidAt: null, payments: [] }),
    ).toBe(0);
  });
});

describe('claimReservationForArrival', () => {
  const row = {
    ...candidate(),
    vehiclePlate: 'AB123CD',
    vehicleCategory: 'car',
    totalArs: new Prisma.Decimal(4500),
    paidAt: at(-600),
    user: { name: 'Lucía' },
    payments: [{ amountArs: new Prisma.Decimal(4500) }],
  };

  function makeTx(rows: unknown[], claimed = 1, liveEarlyMax = 60) {
    return {
      reservation: {
        findMany: jest.fn().mockResolvedValue(rows),
        updateMany: jest.fn().mockResolvedValue({ count: claimed }),
      },
      service: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ earlyArrivalMaxMinutes: liveEarlyMax }),
      },
    };
  }

  it('busca por patente normalizada y estados vinculables, y pasa la reserva a checked_in con guarda', async () => {
    const tx = makeTx([row]);

    const link = await claimReservationForArrival(tx as never, {
      tenantId: TENANT,
      plate: 'ab 123-cd',
      at: at(-8),
    });

    expect(link).toEqual({
      reservationId: 'r-1',
      prepaidAmountArs: 4500,
      arrival: 'on_time',
      minutesEarly: 8,
      minutesLate: 0,
    });
    const findArgs = tx.reservation.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(findArgs.where).toMatchObject({
      tenantId: TENANT,
      vehiclePlate: 'AB123CD',
      status: { in: [ReservationStatus.confirmed, ReservationStatus.no_show] },
    });
    expect(tx.reservation.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'r-1',
        tenantId: TENANT,
        status: ReservationStatus.confirmed,
      },
      data: { status: ReservationStatus.checked_in },
    });
  });

  it('llegada anticipada dentro del tope: vincula y devuelve los minutos', async () => {
    const tx = makeTx([row]);
    const link = await claimReservationForArrival(tx as never, {
      tenantId: TENANT,
      plate: 'AB123CD',
      at: at(-50),
    });
    expect(link).toMatchObject({ arrival: 'early', minutesEarly: 50 });
    // La foto tiene el tope: no hace falta leer el servicio.
    expect(tx.service.findFirst).not.toHaveBeenCalled();
  });

  it('muy temprano (antes del tope): no vincula ni toca la reserva', async () => {
    const tx = makeTx([row]);
    const link = await claimReservationForArrival(tx as never, {
      tenantId: TENANT,
      plate: 'AB123CD',
      at: at(-90),
    });
    expect(link).toBeNull();
    expect(tx.reservation.updateMany).not.toHaveBeenCalled();
  });

  it('tarde, con la reserva ya en no_show: la devuelve a checked_in', async () => {
    const tx = makeTx([{ ...row, status: ReservationStatus.no_show }]);
    const link = await claimReservationForArrival(tx as never, {
      tenantId: TENANT,
      plate: 'AB123CD',
      at: at(90),
    });
    expect(link).toMatchObject({ arrival: 'late', minutesLate: 90 });
    expect(tx.reservation.updateMany).toHaveBeenCalledWith({
      where: { id: 'r-1', tenantId: TENANT, status: ReservationStatus.no_show },
      data: { status: ReservationStatus.checked_in },
    });
  });

  it('después de exitAt no vincula', async () => {
    const tx = makeTx([{ ...row, status: ReservationStatus.no_show }]);
    const link = await claimReservationForArrival(tx as never, {
      tenantId: TENANT,
      plate: 'AB123CD',
      at: at(200),
    });
    expect(link).toBeNull();
    expect(tx.reservation.updateMany).not.toHaveBeenCalled();
  });

  it('reserva sin tope en la foto: usa el valor vivo del servicio', async () => {
    const legacy = {
      ...row,
      policySnapshot: { earlyArrivalMinutes: 15, graceMinutes: 30 },
    };
    const strict = makeTx([legacy], 1, 30);
    expect(
      await claimReservationForArrival(strict as never, {
        tenantId: TENANT,
        plate: 'AB123CD',
        at: at(-50),
      }),
    ).toBeNull();
    expect(strict.service.findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT, code: 'ADVANCE_RESERVATION' },
      select: { earlyArrivalMaxMinutes: true },
    });

    const wide = makeTx([legacy], 1, 90);
    expect(
      await claimReservationForArrival(wide as never, {
        tenantId: TENANT,
        plate: 'AB123CD',
        at: at(-50),
      }),
    ).toMatchObject({ arrival: 'early' });
  });

  it('si otro ingreso ganó la carrera (count 0) no vincula y no tira', async () => {
    const tx = makeTx([row], 0);
    const link = await claimReservationForArrival(tx as never, {
      tenantId: TENANT,
      plate: 'AB123CD',
      at: at(0),
    });
    expect(link).toBeNull();
  });

  it('sin patente utilizable no consulta la base', async () => {
    const tx = makeTx([row]);
    const link = await claimReservationForArrival(tx as never, {
      tenantId: TENANT,
      plate: ' - ',
      at: at(0),
    });
    expect(link).toBeNull();
    expect(tx.reservation.findMany).not.toHaveBeenCalled();
  });
});

describe('fallbackEarlyArrivalMax', () => {
  it('sin fila de servicio usa el default de 60', async () => {
    const db = { service: { findFirst: jest.fn().mockResolvedValue(null) } };
    expect(
      await fallbackEarlyArrivalMax(db as never, TENANT, [
        { entryAt: ENTRY_AT, policySnapshot: null },
      ]),
    ).toBe(60);
  });
});

describe('findUpcomingReservation', () => {
  const row = (entryAt: Date, id = 'r-1') => ({
    ...candidate({
      id,
      entryAt,
      exitAt: new Date(entryAt.getTime() + 3600_000),
    }),
    vehiclePlate: 'AB123CD',
    vehicleCategory: 'car',
    totalArs: new Prisma.Decimal(4500),
    paidAt: at(-600),
    user: { name: 'Lucía' },
    payments: [],
  });
  const makeDb = (rows: unknown[]) => ({
    reservation: { findMany: jest.fn().mockResolvedValue(rows) },
    service: { findFirst: jest.fn() },
  });

  it('busca las confirmed de las próximas 24 h (cruza la medianoche)', async () => {
    // 2026-10-06 23:40 en Buenos Aires.
    const now = new Date('2026-10-07T02:40:00.000Z');
    const db = makeDb([]);
    await findUpcomingReservation(db as never, TENANT, 'ab 123 cd', now);
    expect(db.reservation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: TENANT,
          vehiclePlate: 'AB123CD',
          status: ReservationStatus.confirmed,
          entryAt: {
            gt: now,
            lte: new Date('2026-10-08T02:40:00.000Z'),
          },
        },
        orderBy: { entryAt: 'asc' },
      }),
    );
  });

  it('devuelve la primera a la que todavía es muy temprano para vincular', async () => {
    const now = at(-90);
    const db = makeDb([row(ENTRY_AT)]);
    const upcoming = await findUpcomingReservation(
      db as never,
      TENANT,
      'AB123CD',
      now,
    );
    expect(upcoming?.id).toBe('r-1');
    expect(upcoming?.classification).toEqual({
      arrival: 'too_early',
      minutesEarly: 90,
      minutesLate: 0,
    });
  });

  it('si ya está dentro del tope no es aviso (la vincula el match)', async () => {
    const db = makeDb([row(ENTRY_AT)]);
    expect(
      await findUpcomingReservation(db as never, TENANT, 'AB123CD', at(-30)),
    ).toBeNull();
  });
});

describe('completeReservationForExit', () => {
  it('pasa de checked_in a completed con guarda (repetirlo no hace nada)', async () => {
    const tx = {
      reservation: {
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
      },
    };
    expect(await completeReservationForExit(tx as never, TENANT, 'r-1')).toBe(
      true,
    );
    expect(await completeReservationForExit(tx as never, TENANT, 'r-1')).toBe(
      false,
    );
    expect(tx.reservation.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'r-1',
        tenantId: TENANT,
        status: ReservationStatus.checked_in,
      },
      data: { status: ReservationStatus.completed },
    });
  });
});

it('reservationCode: R- y los últimos 6 del id en mayúsculas', () => {
  expect(reservationCode('0192aa00-0000-7000-8000-00000004f2k9')).toBe(
    'R-04F2K9',
  );
});
