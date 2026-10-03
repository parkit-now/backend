-- Vista previa (SOLO LECTURA) de cómo quedaría cada `vehicle_types` al aplicar
-- la migración 20261005120000_vehicle_categories.sql.
--
-- PARA QUÉ
--
-- El backfill de esa migración le asigna una categoría a cada tipo de vehículo
-- de cada estacionamiento, en tres pasos: (a) por el nombre, (b) por votación de
-- los modelos del catálogo, (c) `other`. Los pasos (b) y (c) quedan "inferidos"
-- y la web le pide al dueño que los revise. Antes de desplegar conviene ver el
-- resultado sobre datos reales y decidir si hace falta ajustar los alias.
--
-- CUÁNDO CORRERLO
--
-- ANTES de aplicar las migraciones, contra una COPIA de producción (o contra
-- producción: sólo hace SELECT dentro de una transacción de lectura). Usa
-- `vehicle_catalog_defaults.type_name`, que la migración 20261005120100 borra:
-- DESPUÉS de ese deploy este script falla, y ya no hace falta.
--
--   psql "$COPIA_DE_PRODUCCION" -f scripts/sql/preview-vehicle-categories.sql
--
-- QUÉ DEVUELVE
--
-- Una fila por tipo (borrados lógicos incluidos), con:
--   paso            a = por nombre | b = por votación | c = other (a revisar)
--   categoria       la que le daría la migración
--   inferida        true en b y c (la web muestra "Revisá la categoría")
--   modelos_catalogo, voto_top, voto_top_cant
--                   el detalle de la votación, para entender un (b) o un (c)
-- Ordenado para revisar primero lo inferido (c, después b); para un resumen,
-- agrupá el resultado por `paso` y `categoria` en una planilla.
--
-- La lista de alias y los umbrales de la votación (al menos 3 modelos del
-- catálogo y al menos 80 %) tienen que coincidir con los de la migración; el
-- spec src/vehicle-categories/vehicle-categories.spec.ts compara los alias.

BEGIN READ ONLY;

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
           vt.tenant_id,
           vt.name,
           vt.deleted_at,
           regexp_replace(
               lower(translate(btrim(vt.name),
                               'áàâäãéèêëíìîïóòôöõúùûüñçÁÀÂÄÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇ',
                               'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC')),
               '[^a-z0-9]', '', 'g') AS nombre
      FROM vehicle_types vt
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
     GROUP BY v.type_id, 2
),
totales AS (
    SELECT type_id, sum(n) AS total FROM votos WHERE category IS NOT NULL GROUP BY type_id
),
ganador AS (
    SELECT DISTINCT ON (g.type_id) g.type_id, g.category, g.n
      FROM votos g
     WHERE g.category IS NOT NULL
     ORDER BY g.type_id, g.n DESC
),
por_voto AS (
    SELECT w.type_id AS id, w.category
      FROM ganador w
      JOIN totales t ON t.type_id = w.type_id
     WHERE t.total >= 3
       AND w.n >= 0.8 * t.total
)
SELECT p.tenant_id,
       te.name                                         AS estacionamiento,
       p.name                                          AS tipo,
       p.deleted_at IS NOT NULL                        AS borrado,
       (SELECT count(*) FROM vehicles v
         WHERE v.type_id = p.id AND v.deleted_at IS NULL) AS modelos_vivos,
       COALESCE(t.total, 0)                            AS modelos_catalogo,
       w.category                                      AS voto_top,
       w.n                                             AS voto_top_cant,
       CASE WHEN pa.category IS NOT NULL THEN 'a'
            WHEN pv.category IS NOT NULL THEN 'b'
            ELSE 'c' END                               AS paso,
       COALESCE(pa.category, pv.category, 'other')     AS categoria,
       pa.category IS NULL                             AS inferida
  FROM pendientes p
  JOIN tenants te        ON te.id = p.tenant_id
  LEFT JOIN por_alias pa ON pa.id = p.id
  LEFT JOIN por_voto  pv ON pv.id = p.id
  LEFT JOIN totales   t  ON t.type_id = p.id
  LEFT JOIN ganador   w  ON w.type_id = p.id
 ORDER BY inferida DESC, paso DESC, categoria, estacionamiento, tipo;

ROLLBACK;
