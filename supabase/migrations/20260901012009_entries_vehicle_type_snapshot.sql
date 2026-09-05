-- `entries.vehicle_type` pasa de enum a texto, y el enum `vehicle_type` se
-- retira.
--
-- POR QUÉ TEXTO Y NO FK A `vehicle_types`
--
-- La regla que queda escrita en el proyecto: CATÁLOGO MUTABLE -> FK
-- normalizada; REGISTRO HISTÓRICO -> snapshot de texto.
--
-- `entries` es histórico. Un ingreso de hace ocho meses no debe romperse ni
-- cambiar de significado porque el dueño renombre "Camión" o lo borre. Es
-- exactamente por lo que `entries` ya denormaliza `vehicle_brand` y
-- `vehicle_model` como texto en vez de apuntar a `vehicles` (la FK se eliminó
-- en 20260605002855_vehicles_catalog_refactor.sql).
--
-- RIESGO DE DATOS: nulo. La columna está 100% en NULL — sólo la escribe
-- POST /tenants/:id/entries/lpr, que no tiene ningún llamador en los tres
-- frontends. Verificado antes de escribir esta migración.
--
-- El CASE igual mapea los ocho valores por si alguna base tuviera datos: `van`
-- va a 'Otro', igual que en la plantilla y en el backfill de vehicles.

ALTER TABLE entries
  ALTER COLUMN vehicle_type TYPE varchar(60)
  USING (CASE vehicle_type::text
      WHEN 'auto'   THEN 'Auto'
      WHEN 'moto'   THEN 'Moto'
      WHEN 'bici'   THEN 'Bici'
      WHEN 'suv'    THEN 'SUV'
      WHEN 'pickup' THEN 'Pickup'
      WHEN 'van'    THEN 'Otro'
      WHEN 'camion' THEN 'Camión'
      WHEN 'otro'   THEN 'Otro'
    END);

-- Ya no queda ninguna columna declarando este tipo.
DROP TYPE vehicle_type;
