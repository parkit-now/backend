-- Configuración de las reservas anticipadas (SCRUM-214).
--
-- Una playa que toma reservas elige UNA de sus tarifas para cobrarlas, la
-- misma para cualquier vehículo, y declara cuántas de sus plazas se pueden
-- reservar. Las dos cosas se configuran en "Servicios → Reservas" del panel
-- web, así que viven en la fila ADVANCE_RESERVATION de `services`.
--
-- `reservable_spots` NO es la columna `spots` que retiró
-- 20260901012826_capacity_total_and_service_code_v2.sql: aquella repartía la
-- capacidad por tipo de vehículo y duplicaba `tenant.settings.capacity`. Esta
-- es el cupo de reservas, un subconjunto de esa capacidad, y no tiene otra
-- fuente. NULL = sin configurar (la playa no ofrece reservas al conductor).
--
-- POR QUÉ FK COMPUESTA: el id de la tarifa lo manda la web. Una FK simple a
-- rates(id) aceptaría la tarifa de OTRO tenant. Mismo patrón que
-- vehicles.type_id. Requiere la UNIQUE (tenant_id, id) en rates.
--
-- ON DELETE SET NULL (reservation_rate_id): las tarifas se borran lógicamente
-- (tombstone) y el backend ignora una tarifa borrada o inactiva; esto es la
-- red contra un DELETE físico. Con la lista de columnas (Postgres 15+) se
-- anula SÓLO reservation_rate_id y no tenant_id, que es NOT NULL.

ALTER TABLE rates
  ADD CONSTRAINT rates_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE services
  ADD COLUMN reservation_rate_id uuid,
  ADD COLUMN reservable_spots integer CHECK (reservable_spots >= 0);

ALTER TABLE services
  ADD CONSTRAINT services_tenant_reservation_rate_fkey
  FOREIGN KEY (tenant_id, reservation_rate_id)
  REFERENCES rates (tenant_id, id)
  ON DELETE SET NULL (reservation_rate_id);

-- La configuración sólo tiene sentido en el servicio de reservas.
ALTER TABLE services
  ADD CONSTRAINT services_reservation_config_only_for_reservations CHECK (
    code = 'ADVANCE_RESERVATION'
    OR (reservation_rate_id IS NULL AND reservable_spots IS NULL)
  );

COMMENT ON COLUMN services.reservation_rate_id IS
  'Tarifa con la que se cotizan y cobran las reservas (sólo ADVANCE_RESERVATION). '
  'NULL = sin configurar.';
COMMENT ON COLUMN services.reservable_spots IS
  'Plazas que se pueden reservar a la vez (sólo ADVANCE_RESERVATION). '
  'NULL = sin configurar.';
