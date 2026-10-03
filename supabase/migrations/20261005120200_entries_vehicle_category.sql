-- El ingreso guarda el tipo y la CATEGORÍA del vehículo.
--
-- POR QUÉ
--
-- `entries.vehicle_type` (el nombre del tipo, texto) sólo lo llena el ingreso
-- por cámara (LPR). Los ingresos manuales —la gran mayoría— lo dejan en NULL,
-- así que las métricas por tipo salen casi vacías. Además un nombre libre no
-- sirve para agrupar: "Autos", "Auto" y "Coche" son la misma categoría.
--
-- QUÉ HACE
--
--   `vehicle_type_id`   uuid NULL, SIN FOREIGN KEY. A propósito: una caja sin
--                       conexión puede mandar un ingreso que referencia un tipo
--                       que el dueño borró mientras tanto (o que todavía no
--                       sincronizó), y no hay que perder un ingreso con plata
--                       adentro por eso. Es un dato de referencia, no una
--                       relación que la base tenga que garantizar.
--   `vehicle_category`  varchar(20) NULL, con FK a `vehicle_categories`. Es la
--                       categoría congelada al ingresar: si el dueño cambia la
--                       categoría de un tipo, los ingresos ya hechos conservan
--                       la que guardaron.
--
-- `vehicle_type` sigue guardando el NOMBRE (snapshot) y ahora también se llena
-- en los ingresos manuales.
--
-- COSTO
--
-- Dos columnas NULL sin default: Postgres no reescribe la tabla y no dispara
-- `entries_before_update`, así que no hay tráfico de sync. La FK se agrega
-- NOT VALID y se valida aparte (todas las filas son NULL, así que alcanza con
-- un lock liviano). Los ingresos históricos quedan en NULL; completarlos es
-- OPCIONAL y NO es una migración: ver
-- scripts/sql/backfill-entries-vehicle-category.sql.

ALTER TABLE entries
    ADD COLUMN vehicle_type_id  uuid,
    ADD COLUMN vehicle_category varchar(20);

ALTER TABLE entries
    ADD CONSTRAINT entries_vehicle_category_fkey
    FOREIGN KEY (vehicle_category) REFERENCES vehicle_categories(code)
    ON UPDATE CASCADE ON DELETE RESTRICT
    NOT VALID;

ALTER TABLE entries VALIDATE CONSTRAINT entries_vehicle_category_fkey;

COMMENT ON COLUMN entries.vehicle_type_id IS
  'Tipo de vehículo elegido al ingresar. SIN FK a propósito: una caja sin '
  'conexión puede referenciar un tipo borrado y no hay que perder el ingreso.';
COMMENT ON COLUMN entries.vehicle_category IS
  'Categoría de la plataforma, congelada al ingresar (vehicle_categories.code). '
  'NULL en los ingresos anteriores a las categorías y en los de cajas viejas.';
