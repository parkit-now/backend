-- La cámara de la entrada, vinculada al estacionamiento.
--
-- QUÉ VA ACÁ Y QUÉ NO
--
-- Solo la IDENTIDAD de la cámara. La URL RTSP y la contraseña se quedan en el
-- equipo (`userData/camera.json`, cifrado con safeStorage) por dos razones: una
-- IP `192.168.x.x` solo tiene sentido dentro de la red de esa playa, y la
-- credencial de la cámara no gana nada viajando a la nube.
--
-- Lo que sí necesita estar del lado del servidor es a qué estacionamiento
-- pertenece cada detección. Hoy `lpr_detection_events.camera_id` y
-- `entries.entry_camera_id` son varchar(100) libres que SIEMPRE valen 'cam-01',
-- porque nadie setea `CAMERA_ID` (ver 20260615225024_lpr_schema.sql). Con esto
-- el dueño fija un identificador propio y las detecciones quedan atribuidas.
--
-- POR QUÉ COLUMNAS Y NO `settings` JSON
--
-- Mismo criterio que `lpr_image_retention_days`
-- (20260901120000_add_tenant_lpr_image_retention_days.sql): la configuración de
-- LPR de un tenant se modeló como columna dedicada, no dentro de la bolsa JSON.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS entry_camera_id    varchar(100),
  ADD COLUMN IF NOT EXISTS entry_camera_label varchar(120);

COMMENT ON COLUMN tenants.entry_camera_id IS
  'Identificador de la cámara de ingreso de esta playa. Es el valor que el '
  'desktop le pasa al servicio como CAMERA_ID y que termina en '
  'lpr_detection_events.camera_id y entries.entry_camera_id. NULL = el '
  'estacionamiento todavía no configuró una cámara IP.';

COMMENT ON COLUMN tenants.entry_camera_label IS
  'Nombre visible de la cámara de ingreso, para que el dueño la reconozca '
  '("Portón Rivadavia"). No participa de ningún cálculo.';
