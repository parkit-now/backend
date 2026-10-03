-- Conductor y reservas pasan a las categorías de la PLATAFORMA.
--
-- POR QUÉ
--
-- El vehículo del conductor (`driver_vehicles.kind`) y los vehículos que una
-- playa deja reservar (`services.reservation_vehicle_kinds`) usaban una lista
-- propia (`car | suv_pickup | motorcycle`) que no se conecta con nada: ni con
-- los tipos de la playa, ni con el catálogo, ni con los ingresos. `suv_pickup`
-- además mezcla dos categorías que una playa puede querer tratar distinto.
-- Con las categorías (20261005120000) hay una sola lista.
--
-- Nada de esto está en producción todavía (las reservas no se desplegaron), así
-- que se renombra sin período de transición: `kind` -> `category` también en la
-- API.
--
-- QUÉ HACE
--
--   1. `driver_vehicles.kind` -> `category`, con FK a `vehicle_categories`.
--      `suv_pickup` pasa a la categoría del catálogo si marca y modelo
--      coinciden con una entrada (una Hilux es `pickup`); si no, a `suv`. Que
--      la categoría sea RESERVABLE lo valida la API, no la base: un conductor
--      podría guardar una bici, sólo que no se la deja reservar.
--   2. `services.reservation_vehicle_kinds` -> `reservation_vehicle_categories`,
--      con CHECK contra las cinco reservables. `suv_pickup` se reemplaza por
--      `suv` Y `pickup` (la playa que aceptaba ambos sigue aceptando ambos).
--   3. `reservations.vehicle_category`: NULL, con FK. Se guarda al reservar la
--      categoría del vehículo del conductor, para que el historial no dependa
--      de que el conductor edite su vehículo después.
--
-- Los UPDATE tocan sólo filas con `suv_pickup`, que existen únicamente en
-- bases de desarrollo.


-- ─── 1. driver_vehicles ─────────────────────────────────────────────────────
ALTER TABLE driver_vehicles DROP CONSTRAINT driver_vehicles_kind_valid;

UPDATE driver_vehicles dv
   SET kind = COALESCE(
           (SELECT d.category
              FROM vehicle_catalog_defaults d
             WHERE lower(btrim(d.brand)) = lower(btrim(dv.brand))
               AND lower(btrim(d.model)) = lower(btrim(dv.model))
             LIMIT 1),
           'suv')
 WHERE dv.kind = 'suv_pickup';

ALTER TABLE driver_vehicles RENAME COLUMN kind TO category;

ALTER TABLE driver_vehicles
    ADD CONSTRAINT driver_vehicles_category_fkey
    FOREIGN KEY (category) REFERENCES vehicle_categories(code)
    ON UPDATE CASCADE ON DELETE RESTRICT;

COMMENT ON COLUMN driver_vehicles.category IS
  'Categoría de la plataforma (vehicle_categories.code). La API sólo deja '
  'guardar las reservables: car, suv, pickup, van y motorcycle.';


-- ─── 2. services ────────────────────────────────────────────────────────────
ALTER TABLE services DROP CONSTRAINT services_reservation_vehicle_kinds_valid;

-- `suv_pickup` -> `suv` + `pickup`, sin duplicados y en el orden canónico.
UPDATE services
   SET reservation_vehicle_kinds = ARRAY(
           SELECT c
             FROM (SELECT DISTINCT c
                     FROM unnest(reservation_vehicle_kinds) AS k,
                          LATERAL unnest(
                              CASE WHEN k = 'suv_pickup'
                                   THEN ARRAY['suv', 'pickup']
                                   ELSE ARRAY[k]
                              END) AS c) AS expandidas
            ORDER BY array_position(
                         ARRAY['car', 'suv', 'pickup', 'van', 'motorcycle'], c))
 WHERE 'suv_pickup' = ANY (reservation_vehicle_kinds);

ALTER TABLE services
    RENAME COLUMN reservation_vehicle_kinds TO reservation_vehicle_categories;

ALTER TABLE services
    ADD CONSTRAINT services_reservation_vehicle_categories_valid CHECK (
        reservation_vehicle_categories
            <@ ARRAY['car', 'suv', 'pickup', 'van', 'motorcycle']::text[]
    );

COMMENT ON COLUMN services.reservation_vehicle_categories IS
  'ADVANCE_RESERVATION: categorías de vehículo (vehicle_categories.code, sólo '
  'las reservables) que pueden reservar desde la app. Vacío = ninguna (la '
  'readiness lo marca como faltante). Es independiente de '
  '`vehicle_types.accepted`, que es lo que se acepta en la caja.';


-- ─── 3. reservations ────────────────────────────────────────────────────────
ALTER TABLE reservations ADD COLUMN vehicle_category varchar(20);

ALTER TABLE reservations
    ADD CONSTRAINT reservations_vehicle_category_fkey
    FOREIGN KEY (vehicle_category) REFERENCES vehicle_categories(code)
    ON UPDATE CASCADE ON DELETE RESTRICT;

COMMENT ON COLUMN reservations.vehicle_category IS
  'Categoría del vehículo del conductor al reservar (snapshot). NULL en las '
  'reservas anteriores a las categorías.';
