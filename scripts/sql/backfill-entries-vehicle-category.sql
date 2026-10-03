-- Completa `entries.vehicle_category` / `entries.vehicle_type_id` de los ingresos
-- HISTÓRICOS (anteriores a las categorías de vehículo).
--
-- ES OPCIONAL, Y NO ES UNA MIGRACIÓN. A propósito: se aplicaría sola en el
-- deploy, y toma un lock que frena la escritura de ingresos. Si no se corre, las
-- métricas por categoría arrancan "desde el deploy" y los ingresos viejos
-- aparecen como "Sin dato". Si se corre, los históricos entran en la torta.
--
-- CUÁNDO CORRERLO
--
--   * DESPUÉS de desplegar las migraciones 20261005120000 a 20261005120300 y el
--     backend nuevo.
--   * En una ventana de POCO TRÁFICO. Hace `LOCK TABLE entries IN SHARE ROW
--     EXCLUSIVE MODE`: mientras dura (el UPDATE y el COMMIT) NADIE puede
--     insertar ni modificar ingresos —las cajas siguen vendiendo y sus
--     operaciones quedan esperando—; las lecturas siguen andando. Por eso
--     `lock_timeout = 10s`: si no consigue el lock en 10 segundos aborta sin
--     haber hecho nada, y se reintenta más tarde.
--   * Tenants grandes: se puede correr de a un estacionamiento para acortar el
--     lock (el script no hace nada con los demás):
--
--         psql "$DIRECT_URL" -v tenant=<uuid> -f scripts/sql/backfill-entries-vehicle-category.sql
--         psql "$DIRECT_URL" -f scripts/sql/backfill-entries-vehicle-category.sql   # todos
--
-- POR QUÉ APAGA EL TRIGGER
--
-- `entries_before_update` (set_entries_sync_fields) sube `sync_seq` y
-- `updated_at` en cada UPDATE. Con el trigger prendido, este UPDATE masivo
-- marcaría TODOS los ingresos históricos como cambiados y cada caja se los
-- volvería a bajar (un `pullChanges(afterSeq)` enorme) por un dato que la caja
-- ni usa. Se apaga dentro de la transacción: si algo falla, el ROLLBACK lo deja
-- prendido; y se vuelve a prender antes del COMMIT. `version` no la toca ningún
-- trigger. Efecto buscado: estos cambios NO viajan por el sync; las cajas
-- conservan los ingresos viejos sin categoría, y sólo el backend (métricas) la
-- lee.
--
-- CÓMO RESUELVE LA CATEGORÍA (sólo ingresos con `vehicle_category IS NULL`)
--
--   1. Por MARCA Y MODELO contra los vehículos vivos del estacionamiento
--      (comparación sin mayúsculas ni espacios sobrantes): toma el tipo de ese
--      vehículo y su categoría. Guarda también `vehicle_type_id`.
--   2. Por el NOMBRE del tipo que mandó la cámara (`vehicle_type`): primero
--      contra los tipos del estacionamiento (vivos antes que borrados), y si no
--      aparece contra los mismos alias que la migración 20261005120000.
--   Lo que no se resuelve queda en NULL ("Sin dato"). `vehicle_type` (el nombre)
--   no se toca.
--
--   La categoría sale de la que tiene HOY el tipo, no de la de aquel día: es la
--   mejor aproximación disponible, y es la razón de que sea un backfill
--   opcional.
--
-- IDEMPOTENTE: sólo toca filas con `vehicle_category IS NULL`, así que la
-- segunda corrida actualiza 0 filas.
--
-- Cuidado con las sesiones abiertas: es una sola transacción. Si el UPDATE tarda
-- más de lo esperado (cientos de miles de ingresos), cortarlo con Ctrl+C hace
-- ROLLBACK y no deja nada a medias.

\if :{?tenant}
\else
\set tenant ''
\endif

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = 0;

LOCK TABLE entries IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE entries DISABLE TRIGGER entries_before_update;

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
candidatos AS (
    SELECT e.id,
           e.tenant_id,
           e.vehicle_brand,
           e.vehicle_model,
           e.vehicle_type,
           regexp_replace(
               lower(translate(btrim(e.vehicle_type),
                               'áàâäãéèêëíìîïóòôöõúùûüñçÁÀÂÄÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇ',
                               'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC')),
               '[^a-z0-9]', '', 'g') AS nombre
      FROM entries e
     WHERE e.vehicle_category IS NULL
       AND (e.vehicle_brand IS NOT NULL OR e.vehicle_type IS NOT NULL)
       AND (:'tenant' = '' OR e.tenant_id = NULLIF(:'tenant', '')::uuid)
),
por_modelo AS (
    SELECT c.id, vt.id AS type_id, vt.category
      FROM candidatos c
      JOIN vehicles v
        ON v.tenant_id = c.tenant_id
       AND v.deleted_at IS NULL
       AND lower(btrim(v.brand)) = lower(btrim(c.vehicle_brand))
       AND lower(btrim(v.model)) = lower(btrim(c.vehicle_model))
      JOIN vehicle_types vt
        ON vt.id = v.type_id
       AND vt.tenant_id = v.tenant_id
),
por_nombre_de_tipo AS (
    SELECT DISTINCT ON (c.id) c.id, vt.id AS type_id, vt.category
      FROM candidatos c
      JOIN vehicle_types vt
        ON vt.tenant_id = c.tenant_id
       AND lower(btrim(vt.name)) = lower(btrim(c.vehicle_type))
     ORDER BY c.id, (vt.deleted_at IS NULL) DESC, vt.created_at, vt.id
),
por_alias AS (
    SELECT c.id, a.category
      FROM candidatos c
      JOIN alias a ON a.nombre = c.nombre
),
resuelto AS (
    SELECT c.id,
           COALESCE(pm.type_id, pn.type_id)                    AS type_id,
           COALESCE(pm.category, pn.category, pa.category)     AS category
      FROM candidatos c
      LEFT JOIN por_modelo         pm ON pm.id = c.id
      LEFT JOIN por_nombre_de_tipo pn ON pn.id = c.id
      LEFT JOIN por_alias          pa ON pa.id = c.id
)
UPDATE entries e
   SET vehicle_type_id  = r.type_id,
       vehicle_category = r.category
  FROM resuelto r
 WHERE e.id = r.id
   AND r.category IS NOT NULL
   AND e.vehicle_category IS NULL;

ALTER TABLE entries ENABLE TRIGGER entries_before_update;

-- Cómo quedó (dentro de la transacción: si no te gusta, ROLLBACK en vez de COMMIT).
SELECT coalesce(vehicle_category, '(sin dato)') AS categoria, count(*) AS ingresos
  FROM entries
 WHERE (:'tenant' = '' OR tenant_id = NULLIF(:'tenant', '')::uuid)
 GROUP BY 1
 ORDER BY 2 DESC;

COMMIT;
