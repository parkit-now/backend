-- Las plazas dejan de ser por tipo de vehículo y pasan a ser UNA capacidad
-- general del estacionamiento.
--
-- EL BUG QUE ESTO CIERRA
--
-- La capacidad se escribía en DOS lugares que no se hablaban:
--   * `PATCH /entities/:id`          -> tenant.settings.capacity  (JSON)
--   * `PATCH /tenants/:id/services/:code` -> services.spots       (tabla)
--
-- El onboarding inicializaba los dos con los mismos tres números, así que
-- arrancaban iguales y divergían para siempre apenas el dueño editaba
-- cualquiera. El dashboard de ocupación leía el JSON; la pantalla de
-- configuración leía la tabla.
--
-- La ironía: la migración que creó `services.spots`
-- (20260607234203_add_schedules_and_services.sql:126) lo declaró textualmente
-- "Replaces tenants.settings.capacity" e hizo el backfill. El reemplazo se
-- decidió y se ejecutó a medias: el JSON nunca se retiró.
--
-- Y eran tres taxonomías desalineadas para una sola pregunta:
--   VehicleType (8 valores) · ServiceCode.VEHICLE_* (5) · capacity (3)
-- ninguna con mapeo contra las otras. Ahora hay una sola: `vehicle_types`, que
-- dice QUÉ acepta la playa (`accepted`), y un escalar que dice CUÁNTAS plazas
-- tiene. El aforo deja de fingir que sabe de carrocerías.


-- ─── (a) capacidad general en tenant.settings.capacity.total ────────────────
-- GREATEST y no una sola fuente: las dos ya divergen en las bases reales, y
-- quedarse con la menor le achicaría la capacidad declarada a alguna playa sin
-- avisar. El dueño corrige después en UN campo.
UPDATE tenants
   SET settings = jsonb_set(
       settings,
       '{capacity}',
       jsonb_build_object('total', GREATEST(
           COALESCE((SELECT sum(sv.spots)
                       FROM services sv
                      WHERE sv.tenant_id = tenants.id
                        AND sv.code::text LIKE 'VEHICLE\_%'), 0),
           COALESCE((settings -> 'capacity' ->> 'carSpots')::int, 0)
         + COALESCE((settings -> 'capacity' ->> 'motorcycleSpots')::int, 0)
         + COALESCE((settings -> 'capacity' ->> 'bicycleSpots')::int, 0)
       )),
       true
   );


-- ─── (b) las solicitudes de onboarding YA guardadas ─────────────────────────
-- `declared_entity` es jsonb con la forma vieja adentro. Sin esto, una
-- solicitud pendiente se muestra rota en /ops/solicitudes y al aprobarla el
-- tenant nace con 0 plazas: `applications.service.approve()` lee
-- `entity.carSpots ?? 0`. No alcanza con cambiar el DTO.
UPDATE onboarding_applications
   SET declared_entity =
       (declared_entity - 'carSpots' - 'motorcycleSpots' - 'bicycleSpots')
       || jsonb_build_object('totalSpots',
              COALESCE((declared_entity ->> 'carSpots')::int, 0)
            + COALESCE((declared_entity ->> 'motorcycleSpots')::int, 0)
            + COALESCE((declared_entity ->> 'bicycleSpots')::int, 0))
 WHERE declared_entity ?| array['carSpots', 'motorcycleSpots', 'bicycleSpots'];


-- ─── (c) services pierde las plazas y los códigos de vehículo ───────────────
-- El DELETE va ANTES del cast del enum: si no, las filas VEHICLE_* no podrían
-- convertirse al tipo nuevo.
--
-- OJO: `services` NO tiene `deleted_at`, así que este DELETE **no emite
-- tombstone**. Los clientes offline que hayan cacheado filas VEHICLE_* se
-- quedan con fantasmas: tienen que purgar de su cache local todo `code` que no
-- esté en el enum. Va en el mismo release, porque el tipo generado de
-- `ServiceCode` cambia igual y el typecheck lo fuerza.
DELETE FROM services WHERE code::text LIKE 'VEHICLE\_%';

ALTER TABLE services DROP COLUMN spots;

-- Postgres no permite quitar valores de un enum: se recrea. Mismo patrón que
-- 20260831190000_vehicles_type_enum_v2.sql.
ALTER TYPE service_code RENAME TO service_code_old;

CREATE TYPE service_code AS ENUM ('ADVANCE_RESERVATION');

ALTER TABLE services
    ALTER COLUMN code TYPE service_code USING code::text::service_code;

DROP TYPE service_code_old;
