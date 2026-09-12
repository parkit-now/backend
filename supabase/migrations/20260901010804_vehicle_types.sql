-- Tipos de vehículo: de enum de Postgres a tabla POR ESTACIONAMIENTO.
--
-- POR QUÉ
--
-- `vehicle_type` era un enum: la plataforma decidía las categorías y el dueño
-- las padecía. Es el mismo problema que el catálogo "global" de vehículos —
-- si el dueño no lo puede tocar, es una limitación disfrazada de taxonomía.
-- Un estacionamiento que trabaja con utilitarios, ambulancias o motorhomes no
-- tenía forma de expresarlo salvo mandando todo a `otro`.
--
-- Ahora cada cuenta nace con siete tipos propios y editables, y agrega los que
-- necesite. "Utilitario" NO está entre los defaults A PROPÓSITO: es el ejemplo
-- canónico de la categoría que el dueño crea, y dejarlo afuera hace que la
-- feature se explique sola la primera vez que alguien la necesita.
--
-- `accepted` reemplaza a `ServiceCode.VEHICLE_*`. Antes "qué vehículos acepta
-- la playa" vivía en un enum de 5 valores fijos que no mapeaba contra los 8 del
-- enum de carrocería ni contra los 3 contadores de `settings.capacity`. Tres
-- taxonomías desalineadas para una sola pregunta. Ahora es una columna de la
-- única taxonomía que queda.


-- ─── 1. Plantilla de la plataforma ──────────────────────────────────────────
-- No se expone por la API del tenant y no tiene pantalla de admin: se edita
-- por migración. Su razón de ser es que las cuentas NUEVAS nazcan con un set
-- sano sin que la plataforma pueda tocar las playas ya existentes.
CREATE TABLE vehicle_type_defaults (
    name     varchar(60) PRIMARY KEY,
    accepted boolean NOT NULL DEFAULT true
);

ALTER TABLE vehicle_type_defaults ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON vehicle_type_defaults FROM anon, authenticated;
-- Sin policies a propósito: solo la lee `bootstrap_tenant_defaults()`, que
-- corre como SECURITY DEFINER. Mismo criterio que `tenants`.

INSERT INTO vehicle_type_defaults (name, accepted) VALUES
    ('Auto',   true),
    ('Moto',   true),
    ('Bici',   true),
    ('SUV',    true),
    ('Pickup', true),
    ('Camión', true),
    ('Otro',   true);


-- ─── 2. La tabla por tenant ─────────────────────────────────────────────────
CREATE SEQUENCE vehicle_types_sync_seq;

CREATE TABLE vehicle_types (
    -- UUIDv7 provisto por el cliente (offline-first): SIN default, igual que
    -- `vehicles` desde 20260603231720_vehicles_client_uuid.sql.
    id         uuid PRIMARY KEY,
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name       varchar(60) NOT NULL,
    accepted   boolean NOT NULL DEFAULT true,

    version    integer NOT NULL DEFAULT 1,
    sync_seq   integer NOT NULL DEFAULT nextval('vehicle_types_sync_seq'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,

    -- Redundante contra la PK, pero es lo que habilita la FK COMPUESTA
    -- (tenant_id, type_id) desde `vehicles`. Sin esto, una FK simple a
    -- vehicle_types(id) aceptaría el id de OTRO tenant — y el id lo manda el
    -- cliente, así que sería un leak cross-tenant real, no teórico.
    CONSTRAINT vehicle_types_tenant_id_id_key UNIQUE (tenant_id, id)
);

-- Unicidad del nombre por estacionamiento: case-insensitive, insensible a
-- espacios sobrantes, y el borrado lógico LIBERA la clave (se puede volver a
-- crear "Camión" después de borrarlo). Mismo criterio que
-- vehicles_scope_brand_model_uidx, pero SIN COALESCE: acá `tenant_id` es NOT
-- NULL, así que no hace falta el centinela para el alcance global.
--
-- Los acentos NO se pliegan, igual que en el índice de vehículos: unaccent()
-- no es IMMUTABLE y no puede ir en una expresión de índice sin un wrapper
-- propio que rompe el orden de pg_dump/pg_restore. "Camion" y "Camión" quedan
-- como tipos distintos; mismo trade-off ya aceptado para Citroen/Citroën.
CREATE UNIQUE INDEX vehicle_types_tenant_name_uidx
    ON vehicle_types (tenant_id, lower(btrim(name)))
    WHERE deleted_at IS NULL;

CREATE INDEX vehicle_types_tenant_id_idx         ON vehicle_types (tenant_id);
CREATE INDEX vehicle_types_tenant_sync_seq_idx   ON vehicle_types (tenant_id, sync_seq);
CREATE INDEX vehicle_types_tenant_updated_at_idx ON vehicle_types (tenant_id, updated_at);


-- ─── 3. Trigger de sync ─────────────────────────────────────────────────────
-- Copia el de RATES, no el de vehicles: NO pisa `version`. El de vehicles
-- (20260605002855) hace `NEW.version := OLD.version + 1`, que es la excepción
-- histórica; el patrón documentado en ADDING_NEW_MODELS.md deja el bump de
-- version en la app, que es lo que hace este módulo.
CREATE OR REPLACE FUNCTION set_vehicle_types_sync_fields()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    NEW.sync_seq   := nextval('vehicle_types_sync_seq');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Solo BEFORE UPDATE: en el INSERT el sync_seq ya lo pone el DEFAULT.
-- Pasarlo a mano es el bug que tuvo que reparar 20260604024720_fix_sync_seq_zero.sql.
CREATE TRIGGER vehicle_types_before_update
BEFORE UPDATE ON vehicle_types
FOR EACH ROW
EXECUTE FUNCTION set_vehicle_types_sync_fields();


-- ─── 4. RLS ─────────────────────────────────────────────────────────────────
-- Segunda capa de defensa (AGENTS.md §5). La primera es `prismaForTenant`; el
-- backend usa service-role, que bypassea RLS, así que esto es para el día que
-- algo entre por PostgREST/supabase-js.
ALTER TABLE vehicle_types ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON vehicle_types FROM anon;

CREATE POLICY vehicle_types_select_same_tenant ON vehicle_types
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY vehicle_types_insert_same_tenant ON vehicle_types
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY vehicle_types_update_same_tenant ON vehicle_types
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    )
    WITH CHECK (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY vehicle_types_delete_same_tenant ON vehicle_types
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );


-- ─── 5. Backfill de los tenants existentes ──────────────────────────────────
-- Los que ya existen reciben los 7 defaults. `accepted` se hereda de lo que el
-- dueño ya había configurado en `services`, usando el mapeo que documenta
-- 20260831190000_vehicles_type_enum_v2.sql:
--     auto -> VEHICLE_CAR · moto -> VEHICLE_MOTORCYCLE · bici -> VEHICLE_BICYCLE
--     suv|pickup|van -> VEHICLE_PICKUP · camion -> VEHICLE_TRUCK
--
-- 'Otro' no tiene ServiceCode equivalente: el CASE cae a NULL, el LEFT JOIN no
-- matchea y el COALESCE lo deja en `true`. Un tenant que nunca tocó `services`
-- queda aceptando todo, que es el default sano para no romperle la operación.
INSERT INTO vehicle_types (id, tenant_id, name, accepted)
SELECT gen_random_uuid(), t.id, d.name, COALESCE(s.enabled, true)
  FROM tenants t
  CROSS JOIN vehicle_type_defaults d
  LEFT JOIN LATERAL (
      SELECT sv.enabled
        FROM services sv
       WHERE sv.tenant_id = t.id
         AND sv.code = (CASE d.name
                WHEN 'Auto'   THEN 'VEHICLE_CAR'
                WHEN 'Moto'   THEN 'VEHICLE_MOTORCYCLE'
                WHEN 'Bici'   THEN 'VEHICLE_BICYCLE'
                WHEN 'SUV'    THEN 'VEHICLE_PICKUP'
                WHEN 'Pickup' THEN 'VEHICLE_PICKUP'
                WHEN 'Camión' THEN 'VEHICLE_TRUCK'
              END)::service_code
       LIMIT 1
  ) s ON true
ON CONFLICT DO NOTHING;
