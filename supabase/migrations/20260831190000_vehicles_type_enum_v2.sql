-- vehicle_type v2: sacar `camioneta`, sumar `bici` y `camion`.
--
-- POR QUÉ
--
-- El enum mezclaba dos taxonomías. `auto|pickup|suv|van` clasifica por
-- CARROCERÍA; `camioneta` clasifica por TAMAÑO/TARIFA. Una Hilux es pickup por
-- carrocería y camioneta por tarifa: las dos cosas a la vez, así que los dos
-- valores se pisaban y nada definía cuál usar.
--
-- El proyecto ya había resuelto esa ambigüedad, pero en otro enum:
-- `ServiceCode.VEHICLE_PICKUP` — el que SÍ tiene plazas asignables
-- (`Service.spots`) y UI real en el portal del dueño — está etiquetado
-- "Camionetas". O sea: pickup ≡ camioneta ya era la decisión vigente. Y el seed
-- histórico cargaba la Ford Ranger como `pickup`, no como `camioneta`.
--
-- Se conserva el detalle de carrocería (suv/pickup/van) en vez de colapsar todo
-- a `camioneta` porque un catálogo de 244 modelos necesita distinguir un Kangoo
-- de una Hilux de un Tucson. Colapsar suv|pickup|van -> camioneta el día que se
-- quiera cobrar por tipo es trivial; al revés la información ya se perdió.
--
-- Se suman `bici` y `camion` porque son categorías de negocio REALES con plazas
-- asignables (ServiceCode.VEHICLE_BICYCLE y VEHICLE_TRUCK, más el "Plazas para
-- bicicletas" del onboarding) que hoy no se podían expresar acá.
--
-- Mapeo a la taxonomía de negocio, para cuando haga falta el join:
--   auto            -> VEHICLE_CAR
--   moto            -> VEHICLE_MOTORCYCLE
--   bici            -> VEHICLE_BICYCLE
--   suv|pickup|van  -> VEHICLE_PICKUP
--   camion          -> VEHICLE_TRUCK
--
-- RIESGO DE DATOS: nulo. `camioneta` tiene 0 filas en toda la historia del
-- proyecto, y `entries.vehicle_type` está todo en NULL (solo lo escribe
-- POST /tenants/:id/entries/lpr, que no tiene ningún llamador).
--
-- Postgres no permite quitar un valor de un enum, así que se recrea el tipo.
-- Mismo patrón que 20260601212225_roles_v2.sql, pero más simple: `vehicle_type`
-- no tiene funciones, vistas, índices ni políticas RLS que lo declaren, así que
-- no hay dependencias que recrear antes del DROP.

ALTER TYPE vehicle_type RENAME TO vehicle_type_old;

CREATE TYPE vehicle_type AS ENUM (
    'auto',
    'moto',
    'bici',
    'suv',
    'pickup',
    'van',
    'camion',
    'otro'
);

ALTER TABLE vehicles
    ALTER COLUMN type TYPE vehicle_type
    USING (
        CASE type::text
            WHEN 'camioneta' THEN 'pickup'
            ELSE type::text
        END
    )::vehicle_type;

ALTER TABLE entries
    ALTER COLUMN vehicle_type TYPE vehicle_type
    USING (
        CASE vehicle_type::text
            WHEN 'camioneta' THEN 'pickup'
            ELSE vehicle_type::text
        END
    )::vehicle_type;

DROP TYPE vehicle_type_old;
