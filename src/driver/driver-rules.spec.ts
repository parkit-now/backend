import { ScheduleDay } from '@prisma/client';
import {
  availableSpots,
  boundingBox,
  distanceMeters,
  hasReservationQuotaFor,
  isOpenAt,
  isOpenThroughout,
  normalizePlate,
  peakConcurrentReservations,
  reservationHoldsSpotNow,
  reservationState,
  reservationWindowProblem,
  windowsOverlap,
  type ScheduleRange,
} from './driver-rules';

// Buenos Aires es UTC-3 sin horario de verano: 12:00 local = 15:00Z.
const ar = (iso: string) => new Date(`${iso}-03:00`);

const allWeek = (openMinute: number, closeMinute: number): ScheduleRange[] =>
  Object.values(ScheduleDay).map((day) => ({ day, openMinute, closeMinute }));

describe('distanceMeters / boundingBox', () => {
  const obelisco = { latitude: -34.6037, longitude: -58.3816 };
  const once = { latitude: -34.6098, longitude: -58.4079 };

  it('mide la distancia en metros', () => {
    expect(Math.round(distanceMeters(obelisco, once))).toBeGreaterThan(2400);
    expect(Math.round(distanceMeters(obelisco, once))).toBeLessThan(2600);
  });

  it('la caja contiene el círculo de búsqueda', () => {
    const box = boundingBox(obelisco, 3000);
    expect(box.minLat).toBeLessThan(once.latitude);
    expect(box.maxLat).toBeGreaterThan(once.latitude);
    expect(box.minLng).toBeLessThan(once.longitude);
    expect(box.maxLng).toBeGreaterThan(once.longitude);
  });
});

describe('horarios', () => {
  it('evalúa en hora argentina', () => {
    const daytime = allWeek(8 * 60, 20 * 60);
    expect(isOpenAt(daytime, ar('2026-09-28T19:59:00'))).toBe(true);
    // 21:00 local = 00:00Z del día siguiente: no debe leerse como medianoche.
    expect(isOpenAt(daytime, ar('2026-09-28T21:00:00'))).toBe(false);
  });

  it('exige que la estadía entera caiga dentro del horario', () => {
    const daytime = allWeek(8 * 60, 20 * 60);
    expect(
      isOpenThroughout(
        daytime,
        ar('2026-09-28T10:00:00'),
        ar('2026-09-28T19:30:00'),
      ),
    ).toBe(true);
    expect(
      isOpenThroughout(
        daytime,
        ar('2026-09-28T18:00:00'),
        ar('2026-09-28T21:00:00'),
      ),
    ).toBe(false);
  });

  it('une rangos pegados: 24 h y nocturno cruzan la medianoche', () => {
    expect(
      isOpenThroughout(
        allWeek(0, 1440),
        ar('2026-09-28T22:00:00'),
        ar('2026-09-29T03:00:00'),
      ),
    ).toBe(true);

    const overnight: ScheduleRange[] = [
      { day: ScheduleDay.monday, openMinute: 20 * 60, closeMinute: 1440 },
      { day: ScheduleDay.tuesday, openMinute: 0, closeMinute: 8 * 60 },
    ];
    // 2026-09-28 es lunes.
    expect(
      isOpenThroughout(
        overnight,
        ar('2026-09-28T22:00:00'),
        ar('2026-09-29T07:00:00'),
      ),
    ).toBe(true);
    expect(
      isOpenThroughout(
        overnight,
        ar('2026-09-28T22:00:00'),
        ar('2026-09-29T09:00:00'),
      ),
    ).toBe(false);
  });

  it('respeta los días cerrados y devuelve null sin horarios', () => {
    const weekdaysOnly: ScheduleRange[] = [
      { day: ScheduleDay.monday, openMinute: 480, closeMinute: 1200 },
    ];
    // 2026-09-27 es domingo.
    expect(isOpenAt(weekdaysOnly, ar('2026-09-27T12:00:00'))).toBe(false);
    expect(isOpenAt([], ar('2026-09-27T12:00:00'))).toBeNull();
  });
});

describe('reservationWindowProblem', () => {
  const now = ar('2026-09-27T16:00:00');

  it('acepta una ventana válida dentro de los 7 días', () => {
    expect(
      reservationWindowProblem(
        ar('2026-09-30T10:00:00'),
        ar('2026-09-30T12:00:00'),
        now,
      ),
    ).toBeNull();
  });

  it('rechaza egreso no posterior, pasado, más de 7 días y más de 24 h', () => {
    expect(
      reservationWindowProblem(
        ar('2026-09-30T12:00:00'),
        ar('2026-09-30T12:00:00'),
        now,
      ),
    ).toBe('exit_not_after_entry');
    expect(
      reservationWindowProblem(
        ar('2026-09-27T10:00:00'),
        ar('2026-09-27T18:00:00'),
        now,
      ),
    ).toBe('entry_in_past');
    expect(
      reservationWindowProblem(
        ar('2026-10-05T10:00:00'),
        ar('2026-10-05T12:00:00'),
        now,
      ),
    ).toBe('entry_too_far');
    expect(
      reservationWindowProblem(
        ar('2026-09-28T10:00:00'),
        ar('2026-09-29T11:00:00'),
        now,
      ),
    ).toBe('stay_too_long');
  });

  it('tolera un reloj de celular levemente atrasado', () => {
    expect(
      reservationWindowProblem(
        ar('2026-09-27T15:57:00'),
        ar('2026-09-27T17:00:00'),
        now,
      ),
    ).toBeNull();
  });
});

describe('reservas: disponibilidad y cupo', () => {
  const now = ar('2026-09-28T10:00:00');
  const window = (from: string, to: string) => ({
    entryAt: ar(`2026-09-28T${from}:00`),
    exitAt: ar(`2026-09-28T${to}:00`),
  });

  const held = (entry: Date) => ({
    entryAt: entry,
    status: 'confirmed' as const,
    holdExpiresAt: null,
  });

  it('una reserva de hoy ocupa lugar hasta 30 min después del ingreso', () => {
    expect(reservationHoldsSpotNow(held(ar('2026-09-28T18:00:00')), now)).toBe(
      true,
    );
    expect(reservationHoldsSpotNow(held(ar('2026-09-28T09:45:00')), now)).toBe(
      true,
    );
    expect(reservationHoldsSpotNow(held(ar('2026-09-28T09:15:00')), now)).toBe(
      false,
    );
  });

  it('usa la tolerancia configurada de la playa', () => {
    const entry = held(ar('2026-09-28T09:45:00'));
    expect(reservationHoldsSpotNow(entry, now, 10)).toBe(false);
    expect(reservationHoldsSpotNow(entry, now, 60)).toBe(true);
  });

  it('una reserva de otro día no descuenta hoy', () => {
    expect(reservationHoldsSpotNow(held(ar('2026-09-29T10:00:00')), now)).toBe(
      false,
    );
    // 22:00 del 27 en Argentina es 01:00Z del 28: no debe contarse como hoy.
    expect(
      reservationHoldsSpotNow(
        held(ar('2026-09-27T22:00:00')),
        ar('2026-09-27T21:00:00'),
      ),
    ).toBe(true);
  });

  it('sólo ocupa lugar si cuenta contra el cupo', () => {
    const entry = ar('2026-09-28T18:00:00');
    const hold = (minutes: number) =>
      new Date(now.getTime() + minutes * 60_000);
    const holds = (
      status: Parameters<typeof reservationState>[0],
      holdExpiresAt: Date | null,
    ) =>
      reservationHoldsSpotNow({ entryAt: entry, status, holdExpiresAt }, now);

    expect(holds('pending_approval', null)).toBe(true);
    expect(holds('checked_in', null)).toBe(true);
    // pending_payment: retención viva (+5 min de margen) o vencida.
    expect(holds('pending_payment', hold(5))).toBe(true);
    expect(holds('pending_payment', hold(-4))).toBe(true);
    expect(holds('pending_payment', hold(-6))).toBe(false);
    expect(holds('pending_payment', null)).toBe(false);
    for (const status of [
      'completed',
      'cancelled',
      'rejected',
      'expired',
      'no_show',
    ] as const) {
      expect(holds(status, null)).toBe(false);
    }
  });

  it('calcula los libres y no baja de cero', () => {
    expect(availableSpots(20, 8, 3)).toBe(9);
    expect(availableSpots(10, 8, 5)).toBe(0);
    expect(availableSpots(0, 3, 1)).toBeNull();
  });

  it('detecta superposición de ventanas (bordes no se pisan)', () => {
    const a = window('10:00', '12:00');
    expect(windowsOverlap(a, window('11:00', '13:00'))).toBe(true);
    expect(windowsOverlap(a, window('12:00', '13:00'))).toBe(false);
  });

  it('cuenta el pico de reservas simultáneas, no las que tocan la ventana', () => {
    const requested = window('10:00', '18:00');
    // 10–11 y 17–18 tocan la ventana pero nunca coinciden: pico 1.
    expect(
      peakConcurrentReservations(
        [window('10:00', '11:00'), window('17:00', '18:00')],
        requested,
      ),
    ).toBe(1);
    // 12–15 y 14–16 coinciden de 14 a 15: pico 2.
    expect(
      peakConcurrentReservations(
        [window('12:00', '15:00'), window('14:00', '16:00')],
        requested,
      ),
    ).toBe(2);
    // Una sale cuando entra la otra: no se pisan.
    expect(
      peakConcurrentReservations(
        [window('10:00', '12:00'), window('12:00', '14:00')],
        requested,
      ),
    ).toBe(1);
    // Fuera de la ventana no cuenta.
    expect(
      peakConcurrentReservations([window('08:00', '10:00')], requested),
    ).toBe(0);
  });

  it('entra mientras el pico quede por debajo del cupo', () => {
    expect(hasReservationQuotaFor(3, 2)).toBe(true);
    expect(hasReservationQuotaFor(3, 3)).toBe(false);
    expect(hasReservationQuotaFor(0, 0)).toBe(false);
  });

  it('deriva el estado de la reserva y normaliza la patente', () => {
    expect(reservationState('confirmed', ar('2026-09-28T12:00:00'), now)).toBe(
      'active',
    );
    expect(reservationState('confirmed', ar('2026-09-28T09:00:00'), now)).toBe(
      'completed',
    );
    expect(reservationState('cancelled', ar('2026-09-28T12:00:00'), now)).toBe(
      'cancelled',
    );
    expect(normalizePlate(' ab-123 cd ')).toBe('AB123CD');
  });

  it('mapea todos los estados del ciclo de vida a los tres que ve la app', () => {
    const future = ar('2026-09-28T12:00:00');
    const past = ar('2026-09-28T09:00:00');
    const expected = {
      pending_payment: 'active',
      pending_approval: 'active',
      confirmed: 'active',
      checked_in: 'active',
      completed: 'completed',
      no_show: 'completed',
      cancelled: 'cancelled',
      rejected: 'cancelled',
      expired: 'cancelled',
    } as const;
    for (const [status, state] of Object.entries(expected)) {
      expect(
        reservationState(status as keyof typeof expected, future, now),
      ).toBe(state);
    }
    // Sólo confirmed / checked_in se derivan de la hora de egreso.
    expect(reservationState('checked_in', past, now)).toBe('completed');
    expect(reservationState('pending_payment', past, now)).toBe('active');
    expect(reservationState('rejected', past, now)).toBe('cancelled');
    expect(reservationState('no_show', future, now)).toBe('completed');
  });
});
