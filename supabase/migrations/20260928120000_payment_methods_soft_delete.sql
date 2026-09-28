-- Borrado lógico en medios de pago, para que las bajas viajen por el sync.
--
-- EL BUG QUE CIERRA
--
-- `deletePaymentMethod` hacía un DELETE físico. Como el feed incremental sólo
-- puede mencionar filas que existen, la baja quedaba encerrada en la máquina
-- que la ejecutó: todos los demás equipos conservaban el medio para siempre,
-- seleccionable en la pantalla de cobro, y cada cobro con él escribía un
-- `payment_transactions.payment_method_id` que el servidor no reconoce.
--
-- No era una ventana de bug ya cerrada como la de `rates`: era el
-- comportamiento de todas las versiones publicadas.
--
-- Es el mismo patrón de `rates` (20260831172808) y `vehicles`
-- (20260608195201), y con esto los medios de pago dejan de ser la única
-- entidad borrable fuera de él. Las tres piezas van juntas o no sirve de nada:
-- la columna, el feed que NO la filtra, y el cliente que borra al ver el
-- tombstone.
--
-- `ADD COLUMN` es DDL y no dispara el trigger de fila, así que las filas
-- existentes conservan su `sync_seq` y no hay un resync espurio masivo.

ALTER TABLE payment_methods
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN payment_methods.deleted_at IS
  'Baja lógica. El feed /payment-methods/changes NO la filtra: mandar la fila '
  'con deleted_at no nulo es exactamente cómo la baja llega a los equipos '
  'offline. Los listados sí la filtran.';

-- El índice único de los métodos de sistema tiene que ignorar los borrados,
-- igual que se hizo con el atajo de `rates`. Sin esto, un tenant no podría
-- volver a tener un método de sistema de un tipo que alguna vez se borró.
DROP INDEX IF EXISTS payment_methods_tenant_system_type_idx;
CREATE UNIQUE INDEX payment_methods_tenant_system_type_idx
  ON payment_methods (tenant_id, type)
  WHERE is_system = true AND deleted_at IS NULL;
