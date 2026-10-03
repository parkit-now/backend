import { Prisma, ReservationStatus } from '@prisma/client';
import {
  arrivalSearchRange,
  arrivalWindow,
  claimReservationForArrival,
  completeReservationForExit,
  isWithinArrivalWindow,
  pickReservationForArrival,
  prepaidAmountOf,
  reservationCode,
} from './reservation-checkin';

const TENANT = '11111111-1111-7111-8111-111111111111';
const ENTRY_AT = new Date('2026-10-06T21:00:00.000Z'); // 18:00 en Buenos Aires
const at = (minutesFromEntry: number) =>
  new Date(ENTRY_AT.getTime() + minutesFromEntry * 60_000);
// Política de la reserva: llega hasta 15' antes, tolerancia de 30'.
const POLICY = { earlyArrivalMinutes: 15, graceMinutes: 30 };

function candidate(
  overrides: Partial<{
    id: string;
    status: ReservationStatus;
    entryAt: Date;
    policySnapshot: unknown;
  }> = {},
) {
  return {
    id: 'r-1',
    status: ReservationStatus.confirmed,
    entryAt: ENTRY_AT,
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

  it('el rango de búsqueda cubre la ventana más amplia posible (120 antes, 180 después)', () => {
    const range = arrivalSearchRange(ENTRY_AT);
    expect(range.gte).toEqual(at(-180));
    expect(range.lte).toEqual(at(120));
  });
});

describe('pickReservationForArrival', () => {
  it('elige la reserva dentro de la ventana', () => {
    expect(pickReservationForArrival([candidate()], at(-8))?.id).toBe('r-1');
  });

  it('fuera de la ventana no hay reserva', () => {
    expect(pickReservationForArrival([candidate()], at(45))).toBeNull();
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
    exitAt: at(180),
    totalArs: new Prisma.Decimal(4500),
    paidAt: at(-600),
    user: { name: 'Lucía' },
    payments: [{ amountArs: new Prisma.Decimal(4500) }],
  };

  function makeTx(rows: unknown[], claimed = 1) {
    return {
      reservation: {
        findMany: jest.fn().mockResolvedValue(rows),
        updateMany: jest.fn().mockResolvedValue({ count: claimed }),
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

    expect(link).toEqual({ reservationId: 'r-1', prepaidAmountArs: 4500 });
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
