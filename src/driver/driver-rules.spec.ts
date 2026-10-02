import { ScheduleDay } from '@prisma/client';
import {
  boundingBox,
  distanceMeters,
  isOpenAt,
  isOpenThroughout,
  reservationWindowProblem,
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
