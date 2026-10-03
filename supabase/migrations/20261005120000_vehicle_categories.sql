-- Categorías de vehículo de la PLATAFORMA (`vehicle_categories`) y la categoría
-- de cada tipo de vehículo de un estacionamiento.
--
-- POR QUÉ
--
-- Hoy hay tres listas de "tipo de vehículo" que no se conectan: los tipos de
-- cada playa (nombre libre y editable), el catálogo de modelos (que apunta al
-- tipo POR NOMBRE) y el tipo del conductor (`car | suv_pickup | motorcycle`).
-- Si el dueño renombra un tipo, el catálogo deja de encontrarlo; si crea
-- "Utilitario", nadie sabe qué es. La solución es una lista cerrada de
-- categorías con código fijo, y que el nombre de cada playa sea una etiqueta
-- que cuelga de una categoría.
--
-- QUÉ HACE
--
--   1. Tabla global `vehicle_categories` (8 filas). No es un enum de Postgres:
--      necesita etiqueta, orden, si se puede reservar y, a futuro, un recargo;
--      y a un enum no se le pueden quitar valores.
--   2. `vehicle_type_defaults.category` (NOT NULL, FK) y el 8º tipo por defecto
--      "Utilitario / Van" -> `van`, SOLO para cuentas nuevas.
--   3. `vehicle_types.category` + `category_inferred`, con backfill de los tipos
--      que ya existen (borrados lógicos incluidos) en tres pasos:
--        (a) por el NOMBRE normalizado contra una lista de alias;
--        (b) por VOTACIÓN de los modelos del catálogo que el tipo tiene
--            asignados (al menos 3 y al menos 80 %);
--        (c) si nada alcanza, `other`.
--      (b) y (c) quedan con `category_inferred = true`: la web muestra "Revisá
--      la categoría" hasta que el dueño la confirme.
--   4. `bootstrap_tenant_defaults()` COMPLETA, con el único cambio de que el
--      bloque 1 inserta `category`.
--
-- SYNC (importante)
--
-- El backfill es un UPDATE sobre `vehicle_types`. Su trigger
-- (`set_vehicle_types_sync_fields`) sólo sube `sync_seq` y `updated_at`, NO
-- `version`: las cajas sin conexión bajan el campo nuevo en su próximo pull y
-- no reciben ningún 409. NO se hace ningún UPDATE sobre `vehicles`
-- (`set_vehicles_sync_fields` sí sube `version`). Las cajas viejas ignoran la
-- columna nueva.
--
-- Los alias de (a) están duplicados en `inferCategoryFromName`
-- (src/vehicle-categories/vehicle-categories.ts); un spec compara ambos.
-- El mismo criterio, de sólo lectura, está en
-- scripts/sql/preview-vehicle-categories.sql.


-- ─── 1. La lista de categorías ──────────────────────────────────────────────
CREATE TABLE vehicle_categories (
    code        varchar(20) PRIMARY KEY CHECK (code ~ '^[a-z_]+$'),
    label       varchar(40) NOT NULL,
    sort_order  smallint    NOT NULL UNIQUE,
    reservable  boolean     NOT NULL DEFAULT false
);

ALTER TABLE vehicle_categories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON vehicle_categories FROM anon, authenticated;
-- Sin policies a propósito: sólo la lee el backend (service_role). Mismo
-- criterio que `vehicle_type_defaults`.

INSERT INTO vehicle_categories (code, label, sort_order, reservable) VALUES
    ('car',        'Auto',             1, true),
    ('suv',        'SUV',              2, true),
    ('pickup',     'Pickup',           3, true),
    ('van',        'Utilitario / Van', 4, true),
    ('motorcycle', 'Moto',             5, true),
    ('bicycle',    'Bici',             6, false),
    ('truck',      'Camión',           7, false),
    ('other',      'Otro',             8, false);

COMMENT ON TABLE vehicle_categories IS
  'Categorías de vehículo de la plataforma (lista cerrada, se cambia sólo por '
  'migración). Los tipos de cada estacionamiento cuelgan de una categoría. '
  '`reservable` = se puede reservar desde la app del conductor.';


-- ─── 2. La plantilla de tipos por defecto ───────────────────────────────────
ALTER TABLE vehicle_type_defaults ADD COLUMN category varchar(20);

UPDATE vehicle_type_defaults
   SET category = CASE name
        WHEN 'Auto'   THEN 'car'
        WHEN 'Moto'   THEN 'motorcycle'
        WHEN 'Bici'   THEN 'bicycle'
        WHEN 'SUV'    THEN 'suv'
        WHEN 'Pickup' THEN 'pickup'
        WHEN 'Camión' THEN 'truck'
        WHEN 'Otro'   THEN 'other'
   END;

-- El 8º tipo. Los 47 modelos del catálogo que hoy se siembran como "Otro" son
-- utilitarios; pasan a este tipo en la migración siguiente (sólo en la
-- plantilla: a las cuentas existentes no se les mueve ningún modelo, eso
-- cambiaría `vehicles.version` y daría 409 en las cajas sin conexión).
INSERT INTO vehicle_type_defaults (name, accepted, category)
VALUES ('Utilitario / Van', true, 'van');

ALTER TABLE vehicle_type_defaults ALTER COLUMN category SET NOT NULL;
ALTER TABLE vehicle_type_defaults
    ADD CONSTRAINT vehicle_type_defaults_category_fkey
    FOREIGN KEY (category) REFERENCES vehicle_categories(code)
    ON UPDATE CASCADE ON DELETE RESTRICT;


-- ─── 3. La categoría de cada tipo de estacionamiento ────────────────────────
ALTER TABLE vehicle_types
    ADD COLUMN category          varchar(20),
    ADD COLUMN category_inferred boolean NOT NULL DEFAULT false;


-- ─── 4. Backfill de los tipos existentes ────────────────────────────────────
--
-- Sólo donde `category IS NULL`, así que correrlo dos veces no escribe nada.
-- Alcanza también a los borrados lógicos: un tipo borrado sigue referenciado
-- por modelos e ingresos viejos y tiene que tener categoría para el NOT NULL.
--
-- Normalización del nombre: minúsculas, acentos plegados con `translate()`
-- (no hay `unaccent` en la base) y fuera todo lo que no sea [a-z0-9]. Así
-- "Pick-up", "PICKUP" y "pick up" son la misma cosa.
--
-- "Camioneta" NO figura en los alias a propósito: en Argentina es tanto una
-- SUV como una pickup, y se resuelve por votación (b) o queda para revisar.
--
-- Votación (b): cada modelo del tipo que también está en el catálogo de la
-- plataforma aporta la categoría que la plantilla le da. Los modelos propios
-- del dueño (que no están en el catálogo) no votan, y tampoco los borrados.
-- En esta migración la plantilla todavía clasifica por nombre de tipo
-- (`type_name`), así que se traduce acá: Auto -> car, SUV -> suv,
-- Pickup -> pickup, Otro -> van (los 47 "Otro" son todos utilitarios).
DO $$
DECLARE
    n_alias  integer;
    n_voto   integer;
    n_otro   integer;
BEGIN
    WITH alias(nombre, category) AS (
        VALUES
            ('auto',        'car'),
            ('autos',       'car'),
            ('automovil',   'car'),
            ('automoviles', 'car'),
            ('coche',       'car'),
            ('coches',      'car'),
            ('suv',         'suv'),
            ('suvs',        'suv'),
            ('crossover',   'suv'),
            ('4x4',         'suv'),
            ('pickup',      'pickup'),
            ('pickups',     'pickup'),
            ('van',         'van'),
            ('vans',        'van'),
            ('utilitario',  'van'),
            ('utilitarios', 'van'),
            ('utilitariovan', 'van'),
            ('furgon',      'van'),
            ('furgones',    'van'),
            ('furgoneta',   'van'),
            ('furgonetas',  'van'),
            ('moto',        'motorcycle'),
            ('motos',       'motorcycle'),
            ('motocicleta', 'motorcycle'),
            ('motocicletas','motorcycle'),
            ('ciclomotor',  'motorcycle'),
            ('ciclomotores','motorcycle'),
            ('bici',        'bicycle'),
            ('bicis',       'bicycle'),
            ('bicicleta',   'bicycle'),
            ('bicicletas',  'bicycle'),
            ('camion',      'truck'),
            ('camiones',    'truck'),
            ('otro',        'other'),
            ('otros',       'other')
    ),
    pendientes AS (
        SELECT vt.id,
               regexp_replace(
                   lower(translate(btrim(vt.name),
                                   'áàâäãéèêëíìîïóòôöõúùûüñçÁÀÂÄÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇ',
                                   'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC')),
                   '[^a-z0-9]', '', 'g') AS nombre
          FROM vehicle_types vt
         WHERE vt.category IS NULL
    ),
    por_alias AS (
        SELECT p.id, a.category
          FROM pendientes p
          JOIN alias a ON a.nombre = p.nombre
    ),
    votos AS (
        SELECT v.type_id,
               CASE d.type_name
                    WHEN 'Auto'   THEN 'car'
                    WHEN 'SUV'    THEN 'suv'
                    WHEN 'Pickup' THEN 'pickup'
                    WHEN 'Otro'   THEN 'van'
               END AS category,
               count(*) AS n
          FROM vehicles v
          JOIN vehicle_catalog_defaults d
            ON lower(btrim(d.brand)) = lower(btrim(v.brand))
           AND lower(btrim(d.model)) = lower(btrim(v.model))
         WHERE v.deleted_at IS NULL
           AND v.type_id IN (SELECT id FROM pendientes)
         GROUP BY v.type_id, 2
    ),
    por_voto AS (
        SELECT DISTINCT ON (g.type_id) g.type_id AS id, g.category
          FROM votos g
          JOIN (SELECT type_id, sum(n) AS total FROM votos GROUP BY type_id) t
            ON t.type_id = g.type_id
         WHERE g.category IS NOT NULL
           AND t.total >= 3
           AND g.n >= 0.8 * t.total
         ORDER BY g.type_id, g.n DESC
    ),
    resuelto AS (
        SELECT p.id,
               COALESCE(pa.category, pv.category, 'other') AS category,
               pa.category IS NULL                          AS inferred
          FROM pendientes p
          LEFT JOIN por_alias pa ON pa.id = p.id
          LEFT JOIN por_voto  pv ON pv.id = p.id
    ),
    actualizado AS (
        UPDATE vehicle_types vt
           SET category          = r.category,
               category_inferred = r.inferred
          FROM resuelto r
         WHERE vt.id = r.id
        RETURNING vt.category, vt.category_inferred
    )
    SELECT count(*) FILTER (WHERE NOT category_inferred),
           count(*) FILTER (WHERE category_inferred AND category <> 'other'),
           count(*) FILTER (WHERE category_inferred AND category = 'other')
      INTO n_alias, n_voto, n_otro
      FROM actualizado;

    RAISE NOTICE 'vehicle_types.category: % por nombre (a), % por votacion del catalogo (b), % como "other" para revisar (c)',
        n_alias, n_voto, n_otro;
END
$$;

ALTER TABLE vehicle_types ALTER COLUMN category SET NOT NULL;

-- ON UPDATE CASCADE por si algún día cambia un código; ON DELETE RESTRICT
-- porque una categoría en uso no se puede borrar.
ALTER TABLE vehicle_types
    ADD CONSTRAINT vehicle_types_category_fkey
    FOREIGN KEY (category) REFERENCES vehicle_categories(code)
    ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE INDEX vehicle_types_tenant_category_idx
    ON vehicle_types (tenant_id, category)
    WHERE deleted_at IS NULL;

COMMENT ON COLUMN vehicle_types.category IS
  'Categoría de la plataforma (vehicle_categories.code). El `name` es sólo la '
  'etiqueta que el dueño le pone en su playa.';
COMMENT ON COLUMN vehicle_types.category_inferred IS
  'true si la categoría la adivinó el sistema (backfill o alta de una caja '
  'vieja sin categoría). La web muestra "Revisá la categoría" hasta que el '
  'dueño la guarda.';


-- ─── 5. El trigger de alta de cuentas, COMPLETO ─────────────────────────────
-- Copia de la versión vigente (20260913204951). Único cambio: el bloque 1
-- inserta `category` (y ahora son OCHO tipos). Los bloques 2, 3 y 4 van tal
-- cual: un `CREATE OR REPLACE` reemplaza el cuerpo entero, no lo parchea.
CREATE OR REPLACE FUNCTION public.bootstrap_tenant_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- 1. Los ocho tipos de vehículo, propios y editables, cada uno con su
    --    categoría de la plataforma.
    INSERT INTO vehicle_types (id, tenant_id, name, accepted, category)
    SELECT gen_random_uuid(), NEW.id, d.name, d.accepted, d.category
      FROM vehicle_type_defaults d
    ON CONFLICT DO NOTHING;

    -- 2. El catálogo, resolviendo el tipo por nombre contra los recién creados.
    --    Una sentencia, no 244 round-trips.
    INSERT INTO vehicles (id, tenant_id, brand, model, type_id)
    SELECT gen_random_uuid(), NEW.id, d.brand, d.model, vt.id
      FROM vehicle_catalog_defaults d
      JOIN vehicle_types vt
        ON vt.tenant_id = NEW.id
       AND vt.deleted_at IS NULL
       AND lower(btrim(vt.name)) = lower(btrim(d.type_name))
    ON CONFLICT DO NOTHING;

    -- 3. Servicios. Antes sólo los creaba applications.approve().
    INSERT INTO services (tenant_id, code, enabled)
    VALUES (NEW.id, 'ADVANCE_RESERVATION', false)
    ON CONFLICT (tenant_id, code) DO NOTHING;

    -- 4. Métodos de pago del sistema. Nombres en español, que es lo que ve el
    --    usuario: editables por el dueño, marcados is_system para que no se
    --    puedan borrar.
    --
    --    `is_default` va en EFECTIVO. Es con lo que arranca el modal de egreso
    --    y es lo que más se cobra en una playa; el dueño lo puede mover cuando
    --    quiera desde su panel.
    INSERT INTO payment_methods (tenant_id, type, name, enabled, is_system, is_default)
    VALUES (NEW.id, 'transfer', 'Transferencia', true, true, false),
           (NEW.id, 'cash',     'Efectivo',      true, true, true)
    ON CONFLICT DO NOTHING;

    RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.bootstrap_tenant_defaults() IS
  'AFTER INSERT ON tenants: siembra los defaults de todo estacionamiento nuevo '
  '(los ocho tipos de vehículo con su categoría, catálogo de modelos, servicios '
  'y los métodos de pago del sistema "Efectivo" —el preseleccionado— y '
  '"Transferencia"). Agregar un default nuevo se hace acá y en ningún otro '
  'lado: los tres caminos de alta de tenants convergen en este trigger.';
