import { MpAccountStatus } from '@prisma/client';
import {
  computeReservationReadiness,
  type ReservationReadinessInput,
} from './reservation-readiness';

const READY: ReservationReadinessInput = {
  mpStatus: MpAccountStatus.linked,
  reservableSpots: 5,
  capacityTotal: 20,
  rateUsable: true,
  vehicleCategories: ['car'],
  hoursMode: 'opening',
  scheduleCount: 7,
  reservationHourCount: 0,
};

describe('computeReservationReadiness', () => {
  it('está lista cuando se cumplen los cinco requisitos', () => {
    expect(computeReservationReadiness(READY)).toEqual({
      ready: true,
      missing: [],
    });
  });

  it.each([
    ['sin cuenta de MP', { mpStatus: null }],
    ['MP con token vencido', { mpStatus: MpAccountStatus.token_expired }],
    ['MP revocada', { mpStatus: MpAccountStatus.revoked }],
  ])('marca mp_account: %s', (_name, patch) => {
    expect(computeReservationReadiness({ ...READY, ...patch }).missing).toEqual(
      ['mp_account'],
    );
  });

  it.each([
    ['sin plazas configuradas', { reservableSpots: null }],
    ['con 0 plazas', { reservableSpots: 0 }],
    ['más plazas que la capacidad', { reservableSpots: 21 }],
  ])('marca spots: %s', (_name, patch) => {
    expect(computeReservationReadiness({ ...READY, ...patch }).missing).toEqual(
      ['spots'],
    );
  });

  it('sin capacidad declarada acepta cualquier cupo positivo', () => {
    expect(
      computeReservationReadiness({
        ...READY,
        capacityTotal: 0,
        reservableSpots: 500,
      }).ready,
    ).toBe(true);
  });

  it('marca rate cuando la tarifa no sirve', () => {
    expect(
      computeReservationReadiness({ ...READY, rateUsable: false }).missing,
    ).toEqual(['rate']);
  });

  it('marca vehicles sin ningún tipo', () => {
    expect(
      computeReservationReadiness({ ...READY, vehicleCategories: [] }).missing,
    ).toEqual(['vehicles']);
  });

  it('hours: en modo opening mira el horario de apertura', () => {
    expect(
      computeReservationReadiness({
        ...READY,
        scheduleCount: 0,
        reservationHourCount: 3,
      }).missing,
    ).toEqual(['hours']);
  });

  it('hours: en modo custom mira los rangos propios', () => {
    const custom = { ...READY, hoursMode: 'custom' };
    expect(
      computeReservationReadiness({
        ...custom,
        reservationHourCount: 0,
      }).missing,
    ).toEqual(['hours']);
    expect(
      computeReservationReadiness({
        ...custom,
        scheduleCount: 0,
        reservationHourCount: 2,
      }).ready,
    ).toBe(true);
  });

  it('lista todo lo que falta en el orden de la pantalla', () => {
    expect(
      computeReservationReadiness({
        mpStatus: null,
        reservableSpots: null,
        capacityTotal: 20,
        rateUsable: false,
        vehicleCategories: [],
        hoursMode: 'opening',
        scheduleCount: 0,
        reservationHourCount: 0,
      }),
    ).toEqual({
      ready: false,
      missing: ['mp_account', 'spots', 'hours', 'vehicles', 'rate'],
    });
  });
});
