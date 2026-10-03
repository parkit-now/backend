import { findScheduleIssues } from './schedule-issues';

const r = (day: string, openMinute: number, closeMinute: number) => ({
  day,
  openMinute,
  closeMinute,
});

describe('findScheduleIssues', () => {
  it('lista vacía o válida no tiene problemas', () => {
    expect(findScheduleIssues([])).toEqual([]);
    expect(
      findScheduleIssues([r('monday', 480, 1200), r('tuesday', 480, 1200)]),
    ).toEqual([]);
  });

  it('detecta open >= close', () => {
    expect(findScheduleIssues([r('monday', 600, 600)])).toEqual([
      { index: 0, kind: 'invalid_range' },
    ]);
    expect(findScheduleIssues([r('monday', 700, 600)])).toEqual([
      { index: 0, kind: 'invalid_range' },
    ]);
  });

  it('detecta solapes en el mismo día', () => {
    expect(
      findScheduleIssues([r('monday', 480, 720), r('monday', 600, 900)]),
    ).toEqual([{ index: 1, kind: 'overlap', overlapsWith: 0 }]);
  });

  it('contiguas (8-12 y 12-20) NO se pisan', () => {
    expect(
      findScheduleIssues([r('monday', 480, 720), r('monday', 720, 1200)]),
    ).toEqual([]);
  });

  it('el mismo horario en días distintos no se pisa', () => {
    expect(
      findScheduleIssues([r('monday', 480, 720), r('tuesday', 480, 720)]),
    ).toEqual([]);
  });

  it('detecta contención total y no depende del orden', () => {
    expect(
      findScheduleIssues([r('friday', 600, 700), r('friday', 480, 1200)]),
    ).toEqual([{ index: 1, kind: 'overlap', overlapsWith: 0 }]);
  });

  it('una franja inválida no se reporta además como solape', () => {
    expect(
      findScheduleIssues([r('monday', 480, 720), r('monday', 900, 600)]),
    ).toEqual([{ index: 1, kind: 'invalid_range' }]);
  });

  it('acepta 24 hs (0-1440)', () => {
    expect(findScheduleIssues([r('sunday', 0, 1440)])).toEqual([]);
  });
});
