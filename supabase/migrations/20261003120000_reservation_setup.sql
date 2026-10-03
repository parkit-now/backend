-- Setup de reservas del dueño (fase 1 de reservas con pago).
--
-- 1. REGLAS EN LA FILA `services` (ADVANCE_RESERVATION), junto a
--    `reservation_rate_id` y `reservable_spots`: vehículos que pueden reservar,
--    modo del horario, aceptación, cancelación, llegada anticipada y tolerancia.
--    Los defaults son los del producto; sólo tienen sentido para
--    ADVANCE_RESERVATION, pero no se prohíben en otros códigos: la API los
--    rechaza (SERVICE_CONFIG_NOT_SUPPORTED) y el default es inocuo.
--
-- 2. `reservation_hours`: rangos propios del horario de reservas cuando
--    `reservation_hours_mode = 'custom'`. Misma forma que `schedules`, pero
--    BACKEND-ONLY: desktop no sincroniza `services` ni `schedules`, así que no
--    lleva `version` ni `sync_seq`. RLS sin policies, como `reservations`. El
--    PUT de la API reemplaza el set completo (borra e inserta en una
--    transacción).
--
-- 3. SNAPSHOT COMPLETO DE LA TARIFA en `reservations`: fracción y topes de 12 h
--    y 24 h, para calcular el excedente de la estadía sin depender de que el
--    dueño no edite la tarifa. Nullables: las reservas previas no los tienen.

ALTER TABLE services
  ADD COLUMN reservation_vehicle_kinds text[] NOT NULL DEFAULT '{}',
  ADD COLUMN reservation_hours_mode text NOT NULL DEFAULT 'opening',
  ADD COLUMN acceptance_mode text NOT NULL DEFAULT 'auto',
  ADD COLUMN approval_window_minutes integer NOT NULL DEFAULT 15,
  ADD COLUMN free_cancel_minutes integer NOT NULL DEFAULT 60,
  ADD COLUMN late_cancel_refund_pct integer NOT NULL DEFAULT 0,
  ADD COLUMN early_arrival_minutes integer NOT NULL DEFAULT 15,
  ADD COLUMN grace_minutes integer NOT NULL DEFAULT 30;

ALTER TABLE services
  ADD CONSTRAINT services_reservation_vehicle_kinds_valid CHECK (
    reservation_vehicle_kinds <@ ARRAY['car', 'suv_pickup', 'motorcycle']::text[]
  ),
  ADD CONSTRAINT services_reservation_hours_mode_valid CHECK (
    reservation_hours_mode IN ('opening', 'custom')
  ),
  ADD CONSTRAINT services_acceptance_mode_valid CHECK (
    acceptance_mode IN ('auto', 'manual')
  ),
  ADD CONSTRAINT services_approval_window_range CHECK (
    approval_window_minutes BETWEEN 5 AND 120
  ),
  ADD CONSTRAINT services_free_cancel_range CHECK (
    free_cancel_minutes BETWEEN 0 AND 1440
  ),
  ADD CONSTRAINT services_late_cancel_refund_range CHECK (
    late_cancel_refund_pct BETWEEN 0 AND 100
  ),
  ADD CONSTRAINT services_early_arrival_range CHECK (
    early_arrival_minutes BETWEEN 0 AND 120
  ),
  ADD CONSTRAINT services_grace_range CHECK (
    grace_minutes BETWEEN 0 AND 180
  );

-- Las playas que ya tenían las reservas activas siguen aceptando todos los
-- vehículos, como hasta ahora.
UPDATE services
   SET reservation_vehicle_kinds = ARRAY['car', 'suv_pickup', 'motorcycle']
 WHERE code = 'ADVANCE_RESERVATION' AND enabled = true;

COMMENT ON COLUMN services.reservation_vehicle_kinds IS
  'ADVANCE_RESERVATION: tipos de vehículo (DriverVehicle.kind) que pueden reservar. '
  'Vacío = ninguno (la readiness lo marca como faltante).';
COMMENT ON COLUMN services.reservation_hours_mode IS
  'ADVANCE_RESERVATION: opening = el horario de apertura; custom = los rangos de reservation_hours.';
COMMENT ON COLUMN services.acceptance_mode IS
  'ADVANCE_RESERVATION: auto = la reserva se confirma sola; manual = el dueño la acepta.';
COMMENT ON COLUMN services.approval_window_minutes IS
  'ADVANCE_RESERVATION: minutos que tiene el dueño para responder en modo manual.';
COMMENT ON COLUMN services.free_cancel_minutes IS
  'ADVANCE_RESERVATION: la cancelación es gratis hasta estos minutos antes del ingreso.';
COMMENT ON COLUMN services.late_cancel_refund_pct IS
  'ADVANCE_RESERVATION: % que se reembolsa si el conductor cancela fuera de la ventana gratis.';
COMMENT ON COLUMN services.early_arrival_minutes IS
  'ADVANCE_RESERVATION: minutos antes de la hora de ingreso desde los que el conductor puede llegar.';
COMMENT ON COLUMN services.grace_minutes IS
  'ADVANCE_RESERVATION: tolerancia tras la hora de ingreso; pasada, la reserva es no-show y libera la plaza.';

CREATE TABLE reservation_hours (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    day          schedule_day NOT NULL,
    open_minute  integer NOT NULL,
    close_minute integer NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reservation_hours_open_range CHECK (open_minute >= 0 AND open_minute < 1440),
    CONSTRAINT reservation_hours_close_range CHECK (close_minute > 0 AND close_minute <= 1440),
    CONSTRAINT reservation_hours_time_order CHECK (close_minute > open_minute)
);

CREATE INDEX reservation_hours_tenant_day_idx ON reservation_hours (tenant_id, day);

ALTER TABLE reservation_hours ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON reservation_hours FROM anon, authenticated;
-- Sin policies a propósito: solo el service_role saltea RLS.

COMMENT ON TABLE reservation_hours IS
  'Rangos del horario de reservas (modo custom). Backend-only (RLS sin policies).';

ALTER TABLE reservations
  ADD COLUMN rate_snapshot_fraction_price_ars numeric(12, 2),
  ADD COLUMN rate_snapshot_media_estadia_price_ars numeric(12, 2),
  ADD COLUMN rate_snapshot_stay_price_ars numeric(12, 2);

COMMENT ON COLUMN reservations.rate_snapshot_fraction_price_ars IS
  'Precio de la fracción de 5 min de la tarifa al reservar (excedente en caja). NULL en reservas previas.';
COMMENT ON COLUMN reservations.rate_snapshot_media_estadia_price_ars IS
  'Tope de 12 h de la tarifa al reservar (0 = sin tope). NULL en reservas previas.';
COMMENT ON COLUMN reservations.rate_snapshot_stay_price_ars IS
  'Tope de 24 h de la tarifa al reservar (0 = sin tope). NULL en reservas previas.';
