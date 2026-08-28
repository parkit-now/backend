import {
  DEFAULT_TIME_ZONE,
  dayKeyIn,
  dayRangeIn,
  partialDayRangeIn,
  shiftDayKey,
} from './metrics-tz';

/** Argentina sits at a fixed UTC-3 with no DST, so local midnight is 03:00Z. */
const AR = DEFAULT_TIME_ZONE;
/** New York exercises the DST paths Argentina never hits. */
const NY = 'America/New_York';

const HOURS = 3_600_000;

describe('metrics-tz', () => {
  describe('dayKeyIn', () => {
    it('resolves the civil day in the requested zone, not UTC', () => {
      // 02:00Z on the 28th is still the evening of the 27th in Argentina.
      const instant = new Date('2026-08-28T02:00:00.000Z');

      expect(dayKeyIn(instant, AR)).toBe('2026-08-27');
      expect(dayKeyIn(instant, 'UTC')).toBe('2026-08-28');
    });

    it('rolls over exactly at local midnight', () => {
      expect(dayKeyIn(new Date('2026-08-28T02:59:59.999Z'), AR)).toBe(
        '2026-08-27',
      );
      expect(dayKeyIn(new Date('2026-08-28T03:00:00.000Z'), AR)).toBe(
        '2026-08-28',
      );
    });
  });

  describe('dayRangeIn', () => {
    it('spans local midnight to local midnight', () => {
      const { gte, lt } = dayRangeIn('2026-08-27', AR);

      expect(gte.toISOString()).toBe('2026-08-27T03:00:00.000Z');
      expect(lt.toISOString()).toBe('2026-08-28T03:00:00.000Z');
    });

    it('is half-open so midnight is never counted in two days', () => {
      const today = dayRangeIn('2026-08-27', AR);
      const tomorrow = dayRangeIn('2026-08-28', AR);

      expect(today.lt.getTime()).toBe(tomorrow.gte.getTime());
    });

    it('produces a 23-hour day when DST springs forward', () => {
      // 2026-03-08 is the US spring-forward date: 02:00 jumps to 03:00.
      const { gte, lt } = dayRangeIn('2026-03-08', NY);

      expect(gte.toISOString()).toBe('2026-03-08T05:00:00.000Z');
      expect(lt.getTime() - gte.getTime()).toBe(23 * HOURS);
    });

    it('produces a 25-hour day when DST falls back', () => {
      // 2026-11-01 is the US fall-back date: 02:00 repeats.
      const { gte, lt } = dayRangeIn('2026-11-01', NY);

      expect(gte.toISOString()).toBe('2026-11-01T04:00:00.000Z');
      expect(lt.getTime() - gte.getTime()).toBe(25 * HOURS);
    });

    it('rejects a malformed day key instead of silently drifting', () => {
      expect(() => dayRangeIn('27-08-2026', AR)).toThrow(/Invalid day key/);
    });
  });

  describe('shiftDayKey', () => {
    it('walks the calendar in both directions', () => {
      expect(shiftDayKey('2026-08-27', -1)).toBe('2026-08-26');
      expect(shiftDayKey('2026-08-27', -7)).toBe('2026-08-20');
      expect(shiftDayKey('2026-08-27', 1)).toBe('2026-08-28');
    });

    it('crosses month and year boundaries', () => {
      expect(shiftDayKey('2026-09-01', -1)).toBe('2026-08-31');
      expect(shiftDayKey('2026-01-01', -1)).toBe('2025-12-31');
    });

    it('handles leap days', () => {
      expect(shiftDayKey('2028-03-01', -1)).toBe('2028-02-29');
      expect(shiftDayKey('2026-03-01', -1)).toBe('2026-02-28');
    });

    it('keeps the weekday aligned when stepping a full week back', () => {
      const day = new Date(`${shiftDayKey('2026-08-27', -7)}T12:00:00Z`);
      const reference = new Date('2026-08-27T12:00:00Z');

      expect(day.getUTCDay()).toBe(reference.getUTCDay());
    });

    it('survives a DST week without slipping a day', () => {
      // Pure calendar math, so a 23-hour day in the middle changes nothing.
      expect(shiftDayKey('2026-03-09', -7)).toBe('2026-03-02');
    });
  });

  describe('partialDayRangeIn', () => {
    it('truncates the day to the elapsed offset', () => {
      const { gte, lt } = partialDayRangeIn('2026-08-26', AR, 9 * HOURS);

      expect(gte.toISOString()).toBe('2026-08-26T03:00:00.000Z');
      expect(lt.toISOString()).toBe('2026-08-26T12:00:00.000Z');
    });

    it('collapses to an empty window at zero elapsed', () => {
      const { gte, lt } = partialDayRangeIn('2026-08-26', AR, 0);

      expect(gte.getTime()).toBe(lt.getTime());
    });

    it('clamps to the real end of a short DST day', () => {
      // 24h elapsed against a 23h day must not spill into the next day.
      const full = dayRangeIn('2026-03-08', NY);
      const partial = partialDayRangeIn('2026-03-08', NY, 24 * HOURS);

      expect(partial.lt.getTime()).toBe(full.lt.getTime());
    });
  });
});
