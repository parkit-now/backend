-- Reservas del conductor (SCRUM-284, SCRUM-261, SCRUM-214).
--
-- 1. TENANT-LOCAL: la reserva ocupa lugar en UNA playa. Lleva `tenant_id` para
--    que la cuenta de cupo y la futura vista del dueño sean por playa, y el
--    `user_id` del conductor, que las lista entre todas las playas.
--
-- 2. EL ID LO MANDA EL CLIENTE (UUID). Es la clave de idempotencia: si el
--    celular reintenta el POST (timeout, doble toque), el mismo id devuelve la
--    reserva ya creada en vez de duplicarla.
--
-- 3. SNAPSHOTS, NO FKs: patente, tarifa y total se copian al crear. Es un
--    registro histórico: si el conductor edita su vehículo o el dueño cambia
--    la tarifa de reservas, la reserva no cambia (mismo criterio que
--    `entries.rate_snapshot_*`). El total lo calcula el servidor con la
--    tarifa de reservas de la playa (cotización), nunca se toma del cliente.
--    La tarifa es la misma para cualquier vehículo: la patente alcanza para
--    reconocer la reserva en el ingreso.
--
-- 4. ESTADOS MÍNIMOS: `confirmed` y `cancelled`. "Completada" y "no-show" se
--    derivan de la hora (`exit_at` pasado; ingreso + tolerancia sin check-in)
--    en vez de guardarse: sin cron que los mantenga. `pending_payment` llega con
--    Mercado Pago (SCRUM-260).
--
-- 5. BACKEND-ONLY: RLS prendida y cero policies, como `payment_intents`. Sólo
--    el service_role (la API) lee y escribe.

CREATE TYPE reservation_status AS ENUM ('confirmed', 'cancelled');

CREATE TABLE reservations (
    id                 uuid PRIMARY KEY,
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vehicle_plate      varchar(10)  NOT NULL,
    entry_at           timestamptz  NOT NULL,
    exit_at            timestamptz  NOT NULL,
    total_ars          numeric(12, 2) NOT NULL,
    rate_snapshot_name varchar(120) NOT NULL,
    rate_snapshot_hour_price_ars numeric(12, 2) NOT NULL,
    status             reservation_status NOT NULL DEFAULT 'confirmed',
    cancelled_at       timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reservations_window_valid CHECK (exit_at > entry_at),
    CONSTRAINT reservations_total_non_negative CHECK (total_ars >= 0),
    CONSTRAINT reservations_plate_format CHECK (vehicle_plate ~ '^[A-Z0-9]{3,10}$'),
    CONSTRAINT reservations_cancelled_consistent CHECK (
        (status = 'cancelled') = (cancelled_at IS NOT NULL)
    )
);

-- Cupo (services.reservable_spots): reservas confirmadas de una playa que se
-- superponen con una ventana.
CREATE INDEX reservations_tenant_window_idx
    ON reservations (tenant_id, entry_at, exit_at)
    WHERE status = 'confirmed';

-- "Mis reservas" del conductor.
CREATE INDEX reservations_user_entry_idx ON reservations (user_id, entry_at DESC);

CREATE OR REPLACE FUNCTION set_reservations_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reservations_before_update
BEFORE UPDATE ON reservations
FOR EACH ROW
EXECUTE FUNCTION set_reservations_updated_at();

ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON reservations FROM anon, authenticated;
-- Sin policies a propósito: solo el service_role saltea RLS.

COMMENT ON TABLE reservations IS
  'Reservas de conductores. Backend-only (RLS sin policies). El id lo genera el '
  'cliente y es la clave de idempotencia del POST.';
