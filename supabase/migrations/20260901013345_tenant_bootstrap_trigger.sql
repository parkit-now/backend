-- Todo estacionamiento nuevo nace con sus defaults, sin importar por dónde
-- entró.
--
-- POR QUÉ UN TRIGGER Y NO UNA LLAMADA DESDE NestJS
--
-- Hay TRES caminos de creación de tenants y ya habían divergido:
--
--   1. Aprobación de solicitud  (admin/applications/applications.service.ts)
--      creaba tenant + services + membresía owner + métodos de pago.
--   2. Alta directa del admin   (admin/parkings/parkings.service.ts)
--      creaba SOLO la fila `tenants`. Sin services, sin métodos de pago y sin
--      membresía: un estacionamiento dado de alta desde el panel nacía manco y
--      sin dueño.
--   3. Seed local               (supabase/seed.sql)
--      dos tenants con id y nombre, nada más.
--
-- O sea que "acordate de llamarlo en cada lugar" ya había fallado en este repo,
-- y en silencio. El trigger hace que los tres caminos converjan en un solo
-- lugar: agregar un default nuevo se hace ACÁ y en ningún otro lado.
--
-- Precedente con el mismo razonamiento escrito en el comentario:
-- 20260507042000_oauth_auto_provision_users.sql, un AFTER INSERT ON auth.users
-- que auto-provisiona `public.users` justamente para "avoid adding
-- provider-specific logic in NestJS".
--
-- COSTO HONESTO: lógica de negocio en la base, invisible para quien lee sólo el
-- TypeScript. Se mitiga con punteros en el schema Prisma y en los dos services.
--
-- SECURITY DEFINER: le permite leer las tablas de plantilla, sobre las que el
-- rol invocante no tiene privilegios (están revocadas para anon y authenticated).

CREATE OR REPLACE FUNCTION public.bootstrap_tenant_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- 1. Los siete tipos de vehículo, propios y editables.
    INSERT INTO vehicle_types (id, tenant_id, name, accepted)
    SELECT gen_random_uuid(), NEW.id, d.name, d.accepted
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

    -- 4. Métodos de pago del sistema. Mismos valores que creaba approve():
    --    nombres genéricos y editables por el dueño, marcados is_system para
    --    que no se puedan borrar.
    INSERT INTO payment_methods (tenant_id, type, name, enabled, is_system, is_default)
    VALUES (NEW.id, 'transfer', 'transfer', true, true, true),
           (NEW.id, 'cash',     'cash',     true, true, false)
    ON CONFLICT DO NOTHING;

    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS on_tenant_created_bootstrap_defaults ON tenants;

CREATE TRIGGER on_tenant_created_bootstrap_defaults
AFTER INSERT ON tenants
FOR EACH ROW
EXECUTE FUNCTION public.bootstrap_tenant_defaults();


-- Los tenants que ya existen no pasaron por el trigger. Se los siembra una vez.
-- Idempotente: el ON CONFLICT cubre re-corridas y los que ya tengan filas.
INSERT INTO vehicle_types (id, tenant_id, name, accepted)
SELECT gen_random_uuid(), t.id, d.name, d.accepted
  FROM tenants t CROSS JOIN vehicle_type_defaults d
ON CONFLICT DO NOTHING;

INSERT INTO vehicles (id, tenant_id, brand, model, type_id)
SELECT gen_random_uuid(), t.id, d.brand, d.model, vt.id
  FROM tenants t
  CROSS JOIN vehicle_catalog_defaults d
  JOIN vehicle_types vt
    ON vt.tenant_id = t.id
   AND vt.deleted_at IS NULL
   AND lower(btrim(vt.name)) = lower(btrim(d.type_name))
ON CONFLICT DO NOTHING;

INSERT INTO services (tenant_id, code, enabled)
SELECT t.id, 'ADVANCE_RESERVATION', false FROM tenants t
ON CONFLICT (tenant_id, code) DO NOTHING;
