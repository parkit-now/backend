import { ScheduleDay } from '@prisma/client';
import {
  effectiveReservationHours,
  rangesOutsideOpening,
} from './reservation-hours';

const range = (day: ScheduleDay, open: number, close: number) => ({
  day,
  openMinute: open * 60,
  closeMinute: close * 60,
});

const MON = ScheduleDay.monday;
const TUE = ScheduleDay.tuesday;

describe('rangesOutsideOpening', () => {
  const opening = [range(MON, 8, 20)];

  it('un rango dentro de la apertura no queda afuera', () => {
    expect(rangesOutsideOpening([range(MON, 9, 18)], opening)).toEqual([]);
    expect(rangesOutsideOpening([range(MON, 8, 20)], opening)).toEqual([]);
  });

  it('devuelve el índice de los que se pasan de la apertura', () => {
    expect(
      rangesOutsideOpening(
        [range(MON, 9, 12), range(MON, 7, 10), range(MON, 19, 21)],
        opening,
      ),
    ).toEqual([1, 2]);
  });

  it('une los rangos de apertura que se tocan', () => {
    const split = [range(MON, 8, 12), range(MON, 12, 20)];
    expect(rangesOutsideOpening([range(MON, 10, 15)], split)).toEqual([]);
  });

  it('no cubre un hueco entre rangos de apertura', () => {
    const split = [range(MON, 8, 12), range(MON, 14, 20)];
    expect(rangesOutsideOpening([range(MON, 11, 15)], split)).toEqual([0]);
  });

  it('un día sin apertura deja todo afuera', () => {
    expect(rangesOutsideOpening([range(TUE, 9, 10)], opening)).toEqual([0]);
  });

  it('sin horario de apertura todos quedan afuera', () => {
    expect(
      rangesOutsideOpening([range(MON, 9, 10), range(TUE, 9, 10)], []),
    ).toEqual([0, 1]);
  });
});

describe('effectiveReservationHours', () => {
  const schedules = [range(MON, 8, 20)];
  const custom = [range(MON, 10, 12)];

  it('en modo opening devuelve la apertura', () => {
    expect(effectiveReservationHours('opening', schedules, custom)).toEqual(
      schedules,
    );
  });

  it('en modo custom devuelve los rangos propios', () => {
    expect(effectiveReservationHours('custom', schedules, custom)).toEqual(
      custom,
    );
  });
});
