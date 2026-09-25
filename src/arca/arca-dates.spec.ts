import { fromArcaDate, toArcaDate } from './arca-dates';

describe('arca-dates', () => {
  it('a las 23:30 en Argentina sigue siendo hoy (en UTC ya es mañana)', () => {
    // 2026-09-24 23:30 en Buenos Aires = 2026-09-25 02:30 UTC.
    expect(toArcaDate(new Date('2026-09-25T02:30:00.000Z'))).toBe('20260924');
  });

  it('a las 00:10 en Argentina ya es el día nuevo', () => {
    expect(toArcaDate(new Date('2026-09-25T03:10:00.000Z'))).toBe('20260925');
  });

  it('parsea AAAAMMDD a medianoche UTC (lo que espera @db.Date)', () => {
    expect(fromArcaDate('20261004')?.toISOString()).toBe(
      '2026-10-04T00:00:00.000Z',
    );
    expect(fromArcaDate('')).toBeNull();
    expect(fromArcaDate('2026-10-04')).toBeNull();
  });
});
