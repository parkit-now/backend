-- `vehicles` pasa a ser tenant-local: se acabó el catálogo global.
--
-- POR QUÉ
--
-- `tenant_id NULL` significaba "global, administrado por la plataforma,
-- read-only para el dueño". Eso miente: si el dueño no lo puede tocar es una
-- limitación disfrazada de categoría; si lo puede tocar, no es global. Cada
-- estacionamiento pasa a tener su copia editable de los 244 modelos.
--
-- Y el tipo deja de ser el enum `vehicle_type` para ser una FK a la tabla
-- `vehicle_types` del propio tenant.
--
-- POR QUÉ FK Y NO TEXTO
--
--   * Renombrar un tipo debe costar UNA fila, no N. Con texto, renombrar
--     "Camión" -> "Camiones" reescribiría todos los vehículos de ese tipo, y
--     cada UPDATE dispara `set_vehicles_sync_fields`, que bumpea sync_seq Y
--     version: el feed inundaría a todos los clientes offline y les
--     invalidaría las `version` cacheadas por un cambio cosmético.
--   * "¿Cuántos vehículos usan este tipo?" —la pregunta que arma el modal de
--     reasignación— con texto depende de que nadie haya escrito "camion" en
--     minúscula.
--
-- POR QUÉ LA FK ES COMPUESTA
--
-- Una FK simple a `vehicle_types(id)` aceptaría el type_id de OTRO tenant. El
-- id lo manda el cliente, así que sería un leak cross-tenant real, no teórico.
-- La compuesta (tenant_id, type_id) lo vuelve imposible a nivel base.
--
-- POR QUÉ `type_id` ES NOT NULL
--
-- Borrar un tipo obliga a reasignar los vehículos que lo usan, así que un
-- vehículo nunca puede quedar sin tipo. Además "Otro" ya es el balde de "sin
-- tipo" y es un tipo real y editable: tener NULL *y* "Otro" sería la misma
-- ambigüedad que este rediseño vino a matar. Y con FK compuesta un nullable
-- desactivaría el chequeo (MATCH SIMPLE de Postgres): nullable no es neutral,
-- debilita el aislamiento.


-- ─── (a) columna nueva, nullable mientras se llena ──────────────────────────
ALTER TABLE vehicles ADD COLUMN type_id uuid;


-- ─── (b) mapear el enum de los vehículos YA propios de un tenant ────────────
-- OJO: dispara `set_vehicles_sync_fields` en cada fila, así que sync_seq y
-- version se bumpean y los clientes offline re-pullean esas filas. Es correcto:
-- la fila cambió de verdad.
--
-- `van` y NULL caen en 'Otro', igual que el mapeo de la plantilla
-- (TEMPLATE_TYPE_NAME en scripts/data/vehicle-types.ts).
UPDATE vehicles v
   SET type_id = vt.id
  FROM vehicle_types vt
 WHERE v.tenant_id IS NOT NULL
   AND vt.tenant_id = v.tenant_id
   AND vt.deleted_at IS NULL
   AND vt.name = CASE v.type::text
        WHEN 'auto'   THEN 'Auto'
        WHEN 'moto'   THEN 'Moto'
        WHEN 'bici'   THEN 'Bici'
        WHEN 'suv'    THEN 'SUV'
        WHEN 'pickup' THEN 'Pickup'
        WHEN 'camion' THEN 'Camión'
        ELSE 'Otro'
      END;


-- ─── (c) los globales se van ────────────────────────────────────────────────
-- DELETE físico y no lógico: una fila con `tenant_id IS NULL` no puede
-- sobrevivir al NOT NULL de (e). No se le debe tombstone a nadie — la migración
-- que los sembraba se borró de esta rama y nunca se pusheó, y `seed.sql` jamás
-- llega a la nube.
--
-- Los clientes offline que los tengan cacheados los limpian en la migración de
-- IndexedDB (Dexie v11): un re-pull no alcanza, porque el servidor deja de
-- mencionar esos ids y el pull sólo agrega o borra lo que el feed nombra.
DELETE FROM vehicles WHERE tenant_id IS NULL;


-- ─── (d) copia de la plantilla para cada tenant existente ───────────────────
-- ON CONFLICT DO NOTHING SIN conflict target: si un tenant ya cargó a mano
-- "Toyota Corolla" como propio, GANA EL SUYO y el default no se copia. Es
-- deliberado: el dueño ya decidió cómo se llama ese modelo en su catálogo.
--
-- No se pasa `sync_seq`: la columna tiene DEFAULT nextval('vehicles_sync_seq').
-- Pasarlo a mano es el bug que reparó 20260604024720_fix_sync_seq_zero.sql.
INSERT INTO vehicles (id, tenant_id, brand, model, type_id)
SELECT gen_random_uuid(), t.id, d.brand, d.model, vt.id
  FROM tenants t
  CROSS JOIN vehicle_catalog_defaults d
  JOIN vehicle_types vt
    ON vt.tenant_id = t.id
   AND vt.deleted_at IS NULL
   AND lower(btrim(vt.name)) = lower(btrim(d.type_name))
ON CONFLICT DO NOTHING;


-- ─── (e) los invariantes ────────────────────────────────────────────────────
ALTER TABLE vehicles ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE vehicles ALTER COLUMN type_id   SET NOT NULL;
ALTER TABLE vehicles DROP COLUMN type;


-- ─── (f) FK compuesta ───────────────────────────────────────────────────────
-- ON DELETE RESTRICT nunca dispara en la práctica: los tipos se borran
-- LÓGICAMENTE (tombstone para el sync). Es la red contra un DELETE físico
-- accidental por consola.
ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_tenant_type_fkey
  FOREIGN KEY (tenant_id, type_id)
  REFERENCES vehicle_types (tenant_id, id)
  ON DELETE RESTRICT;


-- ─── (g) el índice único se simplifica ──────────────────────────────────────
-- Sin NULLs en tenant_id ya no hace falta el COALESCE con el nil UUID: ese
-- centinela existía sólo para que dos filas globales colisionaran entre sí
-- (en Postgres dos NULL nunca chocan en un UNIQUE normal).
DROP INDEX vehicles_scope_brand_model_uidx;

CREATE UNIQUE INDEX vehicles_tenant_brand_model_uidx
    ON vehicles (tenant_id, lower(btrim(brand)), lower(btrim(model)))
    WHERE deleted_at IS NULL;


-- ─── (h) índices de sync tenant-scoped ──────────────────────────────────────
-- El índice global sobre sync_seq deja de tener sentido: el feed ahora filtra
-- siempre por tenant primero.
DROP INDEX vehicles_sync_seq_idx;
CREATE INDEX vehicles_tenant_sync_seq_idx   ON vehicles (tenant_id, sync_seq);
CREATE INDEX vehicles_tenant_updated_at_idx ON vehicles (tenant_id, updated_at);
-- Para el conteo "cuántos vehículos usan este tipo" del modal de reasignación.
CREATE INDEX vehicles_type_id_idx           ON vehicles (type_id);


-- ─── (i) RLS ────────────────────────────────────────────────────────────────
-- `vehicles` tenía RLS habilitado y CERO policies: el hueco que dejó haber sido
-- tabla "global". Todas las demás tablas tenant-local tienen sus cuatro.
--
-- OJO CON EL GRANT: 20260507022857_add_vehicles_entries.sql hizo
-- `REVOKE ALL ... FROM anon, authenticated`. Sin privilegios de tabla las
-- policies no habilitan NADA. Es lo que distingue este caso del de `rates`,
-- que es una tabla nueva y quedó cubierta por los default privileges.
REVOKE ALL ON vehicles FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON vehicles TO authenticated;

CREATE POLICY vehicles_select_same_tenant ON vehicles
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY vehicles_insert_same_tenant ON vehicles
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY vehicles_update_same_tenant ON vehicles
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    )
    WITH CHECK (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY vehicles_delete_same_tenant ON vehicles
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );
