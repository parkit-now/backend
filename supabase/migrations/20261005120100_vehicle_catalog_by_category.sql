-- El catálogo semilla apunta a una CATEGORÍA, no al nombre de un tipo.
--
-- POR QUÉ
--
-- `vehicle_catalog_defaults.type_name` resolvía el tipo de cada modelo POR
-- NOMBRE contra los tipos de la playa recién creada. Funciona sólo mientras
-- nadie renombre y no haya dos tipos iguales; con categorías es directo: cada
-- modelo dice "soy un auto / SUV / pickup / utilitario" y el trigger lo cuelga
-- del tipo de esa categoría que tenga la playa.
--
-- QUÉ HACE
--
--   1. `vehicle_catalog_defaults.category` (NOT NULL, FK) y se borra
--      `type_name`. Mapeo: Auto -> car, SUV -> suv, Pickup -> pickup,
--      Otro -> van (las 47 entradas "Otro" son todas utilitarios). Cualquier
--      otro valor corta la migración: un tipo que no sabemos mapear no se
--      adivina.
--   2. `resolve_tenant_vehicle_type(tenant, categoria)`: devuelve el tipo vivo
--      MÁS ANTIGUO de esa categoría; si no hay, el de `other`; si tampoco, NULL.
--   3. `bootstrap_tenant_defaults()` COMPLETA otra vez, ahora resolviendo el
--      tipo de cada modelo con esa función.
--
-- LAS PLAYAS QUE YA EXISTEN NO SE TOCAN
--
-- Ningún UPDATE sobre `vehicles`: `set_vehicles_sync_fields` sube `version` y
-- eso daría 409 en las cajas sin conexión. Por lo mismo, los 47 utilitarios de
-- una cuenta existente siguen colgando de su "Otro". Sólo las cuentas nuevas
-- nacen con "Utilitario / Van" y sus modelos ahí.


-- ─── 1. El catálogo por categoría ───────────────────────────────────────────
ALTER TABLE vehicle_catalog_defaults ADD COLUMN category varchar(20);

UPDATE vehicle_catalog_defaults
   SET category = CASE type_name
        WHEN 'Auto'   THEN 'car'
        WHEN 'SUV'    THEN 'suv'
        WHEN 'Pickup' THEN 'pickup'
        WHEN 'Otro'   THEN 'van'
   END;

DO $$
DECLARE
    n_sin_mapear integer;
    valores      text;
BEGIN
    SELECT count(*), string_agg(DISTINCT type_name, ', ')
      INTO n_sin_mapear, valores
      FROM vehicle_catalog_defaults
     WHERE category IS NULL;

    IF n_sin_mapear > 0 THEN
        RAISE EXCEPTION
            'vehicle_catalog_defaults: % fila(s) con un type_name sin categoría asignada (%). Mapealo antes de seguir.',
            n_sin_mapear, valores;
    END IF;
END
$$;

ALTER TABLE vehicle_catalog_defaults ALTER COLUMN category SET NOT NULL;
ALTER TABLE vehicle_catalog_defaults
    ADD CONSTRAINT vehicle_catalog_defaults_category_fkey
    FOREIGN KEY (category) REFERENCES vehicle_categories(code)
    ON UPDATE CASCADE ON DELETE RESTRICT;

-- Se lleva puesta la FK a vehicle_type_defaults(name).
ALTER TABLE vehicle_catalog_defaults DROP COLUMN type_name;


-- ─── 2. Resolver el tipo de una playa para una categoría ────────────────────
--
-- Dos tipos de la misma categoría están permitidos; se elige siempre el más
-- antiguo (created_at, y el id para desempatar) para que el resultado sea
-- estable. Si la playa borró todos los de esa categoría cae al de `other`.
--
-- No es SECURITY DEFINER ni se expone: la llama el trigger de alta de cuentas
-- (que sí lo es) y el backend. Se le quita el EXECUTE a la API de PostgREST
-- porque recibe un tenant_id arbitrario.
CREATE OR REPLACE FUNCTION public.resolve_tenant_vehicle_type(
    p_tenant   uuid,
    p_category text
)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT vt.id
           FROM vehicle_types vt
          WHERE vt.tenant_id = p_tenant
            AND vt.category = p_category
            AND vt.deleted_at IS NULL
          ORDER BY vt.created_at, vt.id
          LIMIT 1),
        (SELECT vt.id
           FROM vehicle_types vt
          WHERE vt.tenant_id = p_tenant
            AND vt.category = 'other'
            AND vt.deleted_at IS NULL
          ORDER BY vt.created_at, vt.id
          LIMIT 1)
    )
$$;

REVOKE ALL ON FUNCTION public.resolve_tenant_vehicle_type(uuid, text)
    FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.resolve_tenant_vehicle_type(uuid, text) IS
  'Tipo de vehículo vivo más antiguo de la playa para esa categoría; si no hay, '
  'el de `other`; si tampoco, NULL.';


-- ─── 3. El trigger de alta de cuentas, COMPLETO ─────────────────────────────
-- Copia de la versión anterior (20261005120000). Único cambio: el bloque 2
-- resuelve el tipo de cada modelo por CATEGORÍA con la función de arriba. Los
-- bloques 1, 3 y 4 van tal cual.
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

    -- 2. El catálogo, resolviendo el tipo por CATEGORÍA contra los recién
    --    creados. La función se llama una vez por categoría (8 veces), no una
    --    por modelo. Una sentencia, no 1177 round-trips.
    INSERT INTO vehicles (id, tenant_id, brand, model, type_id)
    SELECT gen_random_uuid(), NEW.id, d.brand, d.model, t.type_id
      FROM vehicle_catalog_defaults d
      JOIN (
            SELECT c.code,
                   public.resolve_tenant_vehicle_type(NEW.id, c.code) AS type_id
              FROM vehicle_categories c
           ) t
        ON t.code = d.category
     WHERE t.type_id IS NOT NULL
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
  '(los ocho tipos de vehículo con su categoría, el catálogo de modelos '
  'resuelto por categoría, servicios y los métodos de pago del sistema '
  '"Efectivo" —el preseleccionado— y "Transferencia"). Agregar un default nuevo '
  'se hace acá y en ningún otro lado: los tres caminos de alta de tenants '
  'convergen en este trigger.';
