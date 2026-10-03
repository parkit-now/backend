import { toApplicationDetailDto } from './applications.mappers';

function detailApp(declaredEntity: Record<string, unknown>) {
  return {
    id: 'app-1',
    status: 'pending_review',
    tenantId: null,
    declaredEntity,
    rejectionReason: null,
    submittedAt: new Date('2026-05-01T00:00:00.000Z'),
    reviewedAt: null,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    applicant: { email: 'applicant@once.test' },
    documents: [],
    _count: { documents: 0 },
  } as unknown as Parameters<typeof toApplicationDetailDto>[0];
}

describe('toApplicationDetailDto', () => {
  it('expone capacidad y horarios declarados', () => {
    const schedules = [
      { day: 'monday' as const, openMinute: 480, closeMinute: 1200 },
    ];
    const dto = toApplicationDetailDto(
      detailApp({ name: 'Centro', totalSpots: 50, schedules }),
    );
    expect(dto.totalSpots).toBe(50);
    expect(dto.schedules).toEqual(schedules);
  });

  it('legalName y cuit ausentes son null; sin capacidad ni horarios', () => {
    const dto = toApplicationDetailDto(detailApp({ name: 'Centro' }));
    expect(dto.legalName).toBeNull();
    expect(dto.cuit).toBeNull();
    expect(dto.totalSpots).toBeNull();
    expect(dto.schedules).toEqual([]);
  });

  it('ignora filas de horarios malformadas', () => {
    const dto = toApplicationDetailDto(
      detailApp({ schedules: [{ day: 'monday' }, null] }),
    );
    expect(dto.schedules).toEqual([]);
  });
});
