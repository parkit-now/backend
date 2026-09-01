-- Unicidad (alcance, marca, modelo) en el catálogo de vehículos:
-- case-insensitive, insensible a espacios sobrantes, ignorando bajas lógicas.
--
-- Hasta hoy no había NINGUNA restricción: se podían crear infinitos
-- "Toyota Corolla" idénticos, incluso duplicando uno que ya existía como global.
--
-- POR QUÉ UN ÍNDICE DE EXPRESIÓN Y NO UN UNIQUE DE TABLA
--
--   * `tenant_id` es NULLABLE y NULL significa "global (admin-managed)". En
--     Postgres dos NULL nunca colisionan en un UNIQUE normal, así que
--     UNIQUE (tenant_id, brand, model) dejaría cargar 'Toyota'/'Corolla' dos
--     veces en el catálogo global — justo el caso que más importa evitar, porque
--     un global duplicado aparece dos veces en el autocompletado de TODOS los
--     estacionamientos. COALESCE(tenant_id, <centinela>) convierte "global" en
--     una clave real y comparable.
--
--   * El centinela es el nil UUID (RFC 4122). `tenants.id` sale siempre de
--     gen_random_uuid() o de un id de seed elegido a mano, así que nunca puede
--     valer 00000000-0000-0000-0000-000000000000.
--
--   * lower()/btrim() hacen que la restricción coincida con cómo escribe una
--     persona: ' toyota ' y 'Toyota' son la misma entrada de catálogo.
--
--   * Los acentos NO se pliegan a propósito: unaccent() no es IMMUTABLE y no
--     puede usarse en una expresión de índice sin envolverlo en un wrapper
--     propio, que es un footgun conocido (rompe el orden de pg_dump/pg_restore).
--     'Citroen' y 'Citroën' quedan como entradas distintas.
--
--   * `WHERE deleted_at IS NULL` libera la clave cuando el vehículo se borra
--     lógicamente, así se puede volver a crear uno con la misma marca/modelo.
--     Mismo truco que rates_tenant_shortcut_number_idx en
--     20260831172808_rates_soft_delete.sql.
--
-- Prisma no puede expresar índices parciales ni de expresión, así que esto vive
-- solo acá; prisma/schema/global/vehicles.prisma lleva un comentario puntero.
--
-- OJO: la colisión "un tenant crea algo que YA existe como global" NO la puede
-- expresar este índice (son dos claves distintas: una con el tenant, otra con el
-- centinela). Prohibirla en el índice también prohibiría que dos tenants
-- distintos tengan el mismo modelo privado, que sí es legítimo. Ese caso se
-- chequea en VehiclesService.assertNoClash.


-- ─── 1. Normalizar los valores existentes ───────────────────────────────────
-- El WHERE con la desigualdad es deliberado: el trigger
-- `set_vehicles_sync_fields` pisa sync_seq Y version en CUALQUIER update, así
-- que un UPDATE sin filtro forzaría a todos los clientes offline a re-bajar el
-- catálogo entero y les invalidaría cualquier `version` cacheada.
UPDATE vehicles
   SET brand = btrim(brand),
       model = btrim(model)
 WHERE brand <> btrim(brand)
    OR model <> btrim(model);


-- ─── 2. Deduplicar ANTES de crear el índice ─────────────────────────────────
-- Sin esto, CREATE UNIQUE INDEX aborta la migración entera en cualquier base que
-- ya haya acumulado duplicados (nada los impedía hasta hoy).
--
-- Se conserva la fila más vieja de cada grupo y se marcan las demás con
-- deleted_at: NUNCA un DELETE físico. El borrado lógico dispara el trigger, que
-- bumpea sync_seq, y la baja viaja a los clientes offline como tombstone por
-- GET /tenants/:tenantId/vehicles/catalog. Un DELETE no emite nada y el desktop
-- (que solo hace bulkPut de lo que recibe) se quedaría con el duplicado para
-- siempre.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
                            lower(btrim(brand)),
                            lower(btrim(model))
               ORDER BY created_at, id
           ) AS rn
      FROM vehicles
     WHERE deleted_at IS NULL
)
UPDATE vehicles v
   SET deleted_at = now()
  FROM ranked r
 WHERE v.id = r.id
   AND r.rn > 1;


-- ─── 3. La restricción ──────────────────────────────────────────────────────
CREATE UNIQUE INDEX vehicles_scope_brand_model_uidx
    ON vehicles (
        COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
        lower(btrim(brand)),
        lower(btrim(model))
    )
    WHERE deleted_at IS NULL;
