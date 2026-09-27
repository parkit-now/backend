-- Dónde está la patente dentro de la imagen del evento.
--
-- Hasta ahora a la nube se subía SOLO el recorte de la patente: un JPEG de
-- 200x60 con un recuadro verde dibujado encima. Alcanzaba para verificar la
-- lectura, pero no para lo que el dueño necesita al auditar — qué vehículo
-- entró, de qué marca, modelo y color. Esa foto existía en el disco del equipo
-- y no salía de ahí.
--
-- Ahora se sube la foto completa del área vigilada, y el recorte pasa a
-- derivarse en el cliente a partir de esta columna. Un solo binario por
-- evento, y cada app decide qué encuadre mostrar.
--
-- POR QUÉ FRACCIONES Y NO PÍXELES
--
-- La imagen se comprime y se reescala antes de subirla (la calidad original no
-- aporta nada una vez que el LPR ya leyó la patente). Un bbox en píxeles del
-- frame original no correspondería a ningún píxel de la imagen que termina en
-- el bucket, y obligaría a guardar también sus dimensiones — dos columnas más
-- que se pueden desincronizar. En fracciones, el recorte es un porcentaje de
-- CSS y sobrevive a cualquier reescalado futuro.
--
-- Tampoco es relativo al ROI de la cámara sino a la imagen guardada: si el
-- instalador recalibra la zona de detección, los eventos viejos siguen siendo
-- correctos.
--
-- ES ADITIVA Y NO TOCA NINGUNA FILA, A PROPÓSITO
--
-- Sin UPDATE masivo no se bumpea el `sync_seq` de nadie, así que los equipos
-- ya instalados no ven un cambio que no les sirve. Los eventos históricos
-- quedan en NULL, y ese NULL es EL DATO: significa "el binario de este evento
-- es del formato viejo, es el recorte chico". Las apps lo usan para no
-- recortar un recorte.

ALTER TABLE lpr_detection_events
  ADD COLUMN IF NOT EXISTS plate_bbox jsonb;

COMMENT ON COLUMN lpr_detection_events.plate_bbox IS
  'Recuadro de la patente dentro de la imagen del evento, como fracciones 0..1 '
  '{x,y,w,h} relativas a esa imagen. NULL = evento anterior al cambio: el '
  'binario del bucket es el recorte de la patente, no la foto completa.';
