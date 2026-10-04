import { ReservationStatus } from '@prisma/client';
import {
  buildPolicySnapshot,
  cancelPreview,
  countsAgainstQuota,
  DEFAULT_POLICY_SNAPSHOT,
  HOLDING_STATUSES,
  readPolicySnapshot,
  snapshotEarlyArrivalMax,
  type CancelBy,
  type CancelPreview,
  type PolicySnapshot,
} from './reservation-policy';

const ar = (iso: string) => new Date(`${iso}-03:00`);
const ENTRY = ar('2026-09-28T18:00:00');
const SNAPSHOT: PolicySnapshot = {
  ...DEFAULT_POLICY_SNAPSHOT,
  freeCancelMinutes: 60,
  lateCancelRefundPct: 50,
};

describe('cancelPreview', () => {
  const cases: {
    name: string;
    status: ReservationStatus;
    by: CancelBy;
    now: string;
    amount?: number;
    snapshot?: PolicySnapshot;
    expected: CancelPreview;
  }[] = [
    {
      name: 'conductor antes del corte: reembolso total',
      status: 'confirmed',
      by: 'driver',
      now: '2026-09-28T16:59:00',
      expected: {
        allowed: true,
        refundArs: 9000,
        kind: 'full',
        reasonCode: 'free_window',
      },
    },
    {
      name: 'conductor justo en el corte: ya cuenta como tardío',
      status: 'confirmed',
      by: 'driver',
      now: '2026-09-28T17:00:00',
      expected: {
        allowed: true,
        refundArs: 4500,
        kind: 'partial',
        reasonCode: 'late_window',
      },
    },
    {
      name: 'conductor entre el corte y el inicio: el porcentaje de la playa',
      status: 'confirmed',
      by: 'driver',
      now: '2026-09-28T17:30:00',
      expected: {
        allowed: true,
        refundArs: 4500,
        kind: 'partial',
        reasonCode: 'late_window',
      },
    },
    {
      name: 'conductor tardío con 0 %: sin reembolso',
      status: 'confirmed',
      by: 'driver',
      now: '2026-09-28T17:30:00',
      snapshot: { ...SNAPSHOT, lateCancelRefundPct: 0 },
      expected: {
        allowed: true,
        refundArs: 0,
        kind: 'none',
        reasonCode: 'late_window',
      },
    },
    {
      name: 'conductor tardío con 100 %: cuenta como total',
      status: 'confirmed',
      by: 'driver',
      now: '2026-09-28T17:30:00',
      snapshot: { ...SNAPSHOT, lateCancelRefundPct: 100 },
      expected: {
        allowed: true,
        refundArs: 9000,
        kind: 'full',
        reasonCode: 'late_window',
      },
    },
    {
      name: 'conductor después del inicio: no puede cancelar',
      status: 'confirmed',
      by: 'driver',
      now: '2026-09-28T18:00:00',
      expected: {
        allowed: false,
        refundArs: 0,
        kind: 'none',
        reasonCode: 'already_started',
      },
    },
    {
      name: 'conductor en pending_approval: total aunque sea tarde',
      status: 'pending_approval',
      by: 'driver',
      now: '2026-09-28T17:45:00',
      expected: {
        allowed: true,
        refundArs: 9000,
        kind: 'full',
        reasonCode: 'pending_approval',
      },
    },
    {
      name: 'conductor en pending_approval después del inicio: no puede',
      status: 'pending_approval',
      by: 'driver',
      now: '2026-09-28T18:05:00',
      expected: {
        allowed: false,
        refundArs: 0,
        kind: 'none',
        reasonCode: 'already_started',
      },
    },
    {
      name: 'conductor en pending_payment: permitido, sin reembolso',
      status: 'pending_payment',
      by: 'driver',
      now: '2026-09-28T16:00:00',
      expected: {
        allowed: true,
        refundArs: 0,
        kind: 'none',
        reasonCode: 'not_paid',
      },
    },
    {
      name: 'conductor con la reserva ya cancelada',
      status: 'cancelled',
      by: 'driver',
      now: '2026-09-28T16:00:00',
      expected: {
        allowed: false,
        refundArs: 0,
        kind: 'none',
        reasonCode: 'not_cancellable',
      },
    },
    {
      name: 'dueño sobre confirmed: total, aun después del inicio',
      status: 'confirmed',
      by: 'owner',
      now: '2026-09-28T18:20:00',
      expected: {
        allowed: true,
        refundArs: 9000,
        kind: 'full',
        reasonCode: 'owner',
      },
    },
    {
      name: 'dueño sobre pending_approval: total',
      status: 'pending_approval',
      by: 'owner',
      now: '2026-09-28T16:00:00',
      expected: {
        allowed: true,
        refundArs: 9000,
        kind: 'full',
        reasonCode: 'owner',
      },
    },
    {
      name: 'dueño sobre una reserva que no está pagada o ya terminó',
      status: 'completed',
      by: 'owner',
      now: '2026-09-28T16:00:00',
      expected: {
        allowed: false,
        refundArs: 0,
        kind: 'none',
        reasonCode: 'not_cancellable',
      },
    },
    {
      name: 'redondea el reembolso a 2 decimales',
      status: 'confirmed',
      by: 'driver',
      now: '2026-09-28T17:30:00',
      amount: 1000.01,
      snapshot: { ...SNAPSHOT, lateCancelRefundPct: 33 },
      expected: {
        allowed: true,
        refundArs: 330,
        kind: 'partial',
        reasonCode: 'late_window',
      },
    },
  ];

  it.each(cases)('$name', (testCase) => {
    const result = cancelPreview(
      testCase.snapshot ?? SNAPSHOT,
      testCase.amount ?? 9000,
      ar(testCase.now),
      ENTRY,
      testCase.status,
      testCase.by,
    );
    expect(result).toEqual(testCase.expected);
  });

  it('sin plata cobrada (monto 0) nunca reembolsa', () => {
    const result = cancelPreview(
      SNAPSHOT,
      0,
      ar('2026-09-28T10:00:00'),
      ENTRY,
      'confirmed',
      'driver',
    );
    expect(result).toMatchObject({ allowed: true, refundArs: 0, kind: 'none' });
  });
});

describe('countsAgainstQuota', () => {
  const now = ar('2026-09-28T12:00:00');
  const hold = (minutesFromNow: number) =>
    new Date(now.getTime() + minutesFromNow * 60_000);

  it('pending_approval, confirmed y checked_in siempre cuentan', () => {
    for (const status of [
      'pending_approval',
      'confirmed',
      'checked_in',
    ] as const) {
      expect(countsAgainstQuota({ status, holdExpiresAt: null }, now)).toBe(
        true,
      );
    }
  });

  it('los estados terminales no cuentan', () => {
    for (const status of [
      'completed',
      'cancelled',
      'rejected',
      'expired',
      'no_show',
    ] as const) {
      expect(countsAgainstQuota({ status, holdExpiresAt: hold(5) }, now)).toBe(
        false,
      );
    }
  });

  it('pending_payment cuenta con la retención viva y 5 minutos más', () => {
    const pending = (holdExpiresAt: Date | null) => ({
      status: 'pending_payment' as const,
      holdExpiresAt,
    });
    expect(countsAgainstQuota(pending(hold(3)), now)).toBe(true);
    expect(countsAgainstQuota(pending(hold(-4)), now)).toBe(true);
    expect(countsAgainstQuota(pending(hold(-5)), now)).toBe(false);
    expect(countsAgainstQuota(pending(hold(-30)), now)).toBe(false);
    expect(countsAgainstQuota(pending(null), now)).toBe(false);
  });

  it('HOLDING_STATUSES lista los cuatro estados que retienen lugar', () => {
    expect([...HOLDING_STATUSES].sort()).toEqual([
      'checked_in',
      'confirmed',
      'pending_approval',
      'pending_payment',
    ]);
  });
});

describe('policy snapshot', () => {
  it('copia las reglas del Service y normaliza el modo', () => {
    expect(
      buildPolicySnapshot({
        freeCancelMinutes: 90,
        lateCancelRefundPct: 20,
        earlyArrivalMinutes: 10,
        graceMinutes: 45,
        acceptanceMode: 'manual',
        approvalWindowMinutes: 30,
        earlyArrivalMaxMinutes: 120,
      }),
    ).toEqual({
      freeCancelMinutes: 90,
      lateCancelRefundPct: 20,
      earlyArrivalMinutes: 10,
      graceMinutes: 45,
      acceptanceMode: 'manual',
      approvalWindowMinutes: 30,
      earlyArrivalMaxMinutes: 120,
    });
  });

  it('el tope de llegada anticipada sale del snapshot o es null en las reservas viejas', () => {
    expect(snapshotEarlyArrivalMax({ earlyArrivalMaxMinutes: 45 })).toBe(45);
    expect(snapshotEarlyArrivalMax({ earlyArrivalMaxMinutes: 0 })).toBe(0);
    expect(snapshotEarlyArrivalMax({ earlyArrivalMinutes: 15 })).toBeNull();
    expect(snapshotEarlyArrivalMax({ earlyArrivalMaxMinutes: -5 })).toBeNull();
    expect(snapshotEarlyArrivalMax(null)).toBeNull();
    // Para mostrar, la reserva vieja usa el default.
    expect(readPolicySnapshot({}).earlyArrivalMaxMinutes).toBe(60);
  });

  it('una reserva vieja (snapshot NULL) cae en los defaults', () => {
    expect(readPolicySnapshot(null)).toEqual(DEFAULT_POLICY_SNAPSHOT);
    expect(readPolicySnapshot('basura')).toEqual(DEFAULT_POLICY_SNAPSHOT);
  });

  it('lee el jsonb guardado y completa lo que falta', () => {
    expect(
      readPolicySnapshot({ graceMinutes: 10, acceptanceMode: 'manual' }),
    ).toEqual({
      ...DEFAULT_POLICY_SNAPSHOT,
      graceMinutes: 10,
      acceptanceMode: 'manual',
    });
  });
});
