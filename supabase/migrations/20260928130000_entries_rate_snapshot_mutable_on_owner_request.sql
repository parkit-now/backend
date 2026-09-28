-- El snapshot de tarifa deja de ser estrictamente inmutable.
--
-- Esta migración NO cambia ninguna estructura: sólo corrige comentarios que
-- ahora dirían algo falso. Supersede lo que afirman
-- `20260603225951_entries_offline_sync.sql` ("Captured at vehicle entry time so
-- later rate edits don't affect in-progress stays") y el bloque de
-- `20260916120000_rates_media_estadia_price.sql`. Las migraciones ya aplicadas
-- no se editan, así que la corrección va acá.
--
-- QUÉ CAMBIÓ
--
-- El dueño puede, al editar los PRECIOS de una tarifa, decidir que los autos
-- que están adentro con esa tarifa pasen a los precios nuevos. Es una pregunta
-- explícita, con una persona contestándola, y por defecto la respuesta es que
-- no. Sin esa decisión el comportamiento es el de siempre.
--
-- Vale aclarar qué NO cambió, porque es lo que sigue sosteniendo el modelo: el
-- cobro se calcula siempre contra el snapshot y nunca releyendo la tarifa viva,
-- y las estadías ya cerradas no se tocan nunca.

COMMENT ON COLUMN entries.rate_snapshot_hour_price_ars IS
  'Precio de la hora congelado al ingresar. Ninguna edición de tarifa lo mueve '
  'por sí sola. Hay exactamente dos formas de reescribirlo, las dos con una '
  'persona decidiendo: corregir la estadía y elegir otra tarifa, o que el dueño '
  'edite los precios y responda que sí a pasar los autos que están adentro. '
  'Las estadías ya cerradas no se tocan nunca.';

COMMENT ON COLUMN entries.rate_snapshot_fraction_price_ars IS
  'Precio de la fracción congelado al ingresar. Ver rate_snapshot_hour_price_ars.';

COMMENT ON COLUMN entries.rate_snapshot_stay_price_ars IS
  'Precio de la estadía congelado al ingresar. Ver rate_snapshot_hour_price_ars.';

COMMENT ON COLUMN entries.rate_snapshot_media_estadia_price_ars IS
  'Precio de la media estadía congelado al ingresar. Ver '
  'rate_snapshot_hour_price_ars. NULL = la tarifa no tenía este escalón cuando '
  'el auto entró.';

COMMENT ON COLUMN entries.rate_snapshot_name IS
  'Nombre de la tarifa congelado al ingresar. A diferencia de los precios, este '
  'NO se propaga nunca: renombrar una tarifa no pregunta nada, así que cambiar '
  'el nombre del ticket sin avisar sería una sorpresa.';
