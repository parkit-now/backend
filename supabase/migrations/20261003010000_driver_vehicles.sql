-- Vehículos del conductor (SCRUM-285).
--
-- 1. GLOBAL, NO TENANT-LOCAL: el vehículo es del conductor y lo usa en
--    cualquier playa. Se lee y escribe siempre por `user_id`.
--
-- 2. PATENTE NORMALIZADA (mayúsculas, sin espacios ni guiones), única por
--    conductor. Es la que se copia en la reserva y con la que la cámara de la
--    playa la va a reconocer: dos vehículos del mismo conductor con la misma
--    patente no tienen sentido.
--
-- 3. UN SOLO PRINCIPAL por conductor: índice único parcial sobre
--    `is_primary`. El principal es el que la app sugiere al reservar.
--
-- 4. CATEGORÍA del vehículo (car | suv_pickup | motorcycle): dato del
--    vehículo para el conductor; la reserva se cobra con la tarifa de
--    reservas de la playa, igual para cualquier vehículo.
--
-- 5. BORRADO FÍSICO: las reservas guardan su propia copia de la patente, así
--    que borrar el vehículo no toca el historial. Mientras el vehículo tenga
--    una reserva activa no se puede borrar ni cambiar su patente o categoría
--    (lo valida el backend).
--
-- 6. BACKEND-ONLY: RLS prendida y cero policies, como `reservations`. Sólo el
--    service_role (la API) lee y escribe.

CREATE TABLE driver_vehicles (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plate       varchar(10) NOT NULL,
    kind        varchar(20) NOT NULL,
    brand       varchar(60),
    model       varchar(60),
    is_primary  boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT driver_vehicles_plate_format CHECK (plate ~ '^[A-Z0-9]{3,10}$'),
    CONSTRAINT driver_vehicles_kind_valid
        CHECK (kind IN ('car', 'suv_pickup', 'motorcycle')),
    CONSTRAINT driver_vehicles_user_plate_key UNIQUE (user_id, plate)
);

-- Un solo principal por conductor.
CREATE UNIQUE INDEX driver_vehicles_one_primary_idx
    ON driver_vehicles (user_id)
    WHERE is_primary;

CREATE OR REPLACE FUNCTION set_driver_vehicles_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER driver_vehicles_before_update
BEFORE UPDATE ON driver_vehicles
FOR EACH ROW
EXECUTE FUNCTION set_driver_vehicles_updated_at();

ALTER TABLE driver_vehicles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON driver_vehicles FROM anon, authenticated;
-- Sin policies a propósito: solo el service_role saltea RLS.

COMMENT ON TABLE driver_vehicles IS
  'Vehículos del conductor (globales, por user_id). Backend-only (RLS sin '
  'policies). Patente normalizada y única por conductor; un solo principal.';
