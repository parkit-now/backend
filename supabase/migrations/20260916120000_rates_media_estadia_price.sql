-- Escalón de "media estadía" (12h) y autocálculo de la fracción legal.
--
-- El motor de cobro pasa a tener cuatro precios, no tres: hora, fracción de 5
-- minutos, media estadía (tope de las 12h) y estadía (tope de las 24h). Ver
-- `src/entries/pricing.ts` para las reglas completas.
--
-- `auto_fraction_price` es una preferencia del formulario de tarifas, no un
-- dato de cobro: tildada, la fracción se deriva de la hora (hora ÷ 12, el techo
-- que fija la normativa) y se recalcula sola al cambiar el precio de la hora.
-- El valor derivado igual se materializa en `fraction_price_ars`, así el motor
-- de cobro nunca tiene que conocer este flag.

ALTER TABLE rates
  ADD COLUMN IF NOT EXISTS media_estadia_price_ars numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_fraction_price boolean NOT NULL DEFAULT false;

-- Backfill decidido por el dueño de producto: media estadía = estadía ÷ 2.
--
-- Este UPDATE dispara `rates_before_update` y bumpea `sync_seq` de todas las
-- tarifas. Acá eso se busca: es lo que hace llegar el valor nuevo a los
-- clientes offline. El riesgo conocido (un desktop VIEJO consume el bump con el
-- mapper viejo y avanza su cursor, perdiéndose el campo para siempre) lo cubre
-- el reset de cursores de la versión 14 de Dexie.
UPDATE rates SET media_estadia_price_ars = ROUND(stay_price_ars / 2, 2);

ALTER TABLE rates
  DROP CONSTRAINT IF EXISTS rates_media_estadia_price_ars_non_negative;

ALTER TABLE rates
  ADD CONSTRAINT rates_media_estadia_price_ars_non_negative
  CHECK (media_estadia_price_ars >= 0);

COMMENT ON COLUMN rates.media_estadia_price_ars IS
  'Tope de las primeras 12 horas de estadía. 0 significa que la tarifa NO tiene '
  'este escalón (se pasa del tope por hora directo al de estadía), nunca que '
  'las primeras 12 horas sean gratis.';

COMMENT ON COLUMN rates.auto_fraction_price IS
  'Preferencia de UI: la fracción se deriva de hora ÷ 12 y el campo queda de '
  'solo lectura en el formulario. El valor derivado se guarda igual en '
  'fraction_price_ars; el motor de cobro no lee este flag.';

-- Snapshot en entries: nullable y SIN backfill, a propósito.
--
-- Una estadía abierta hoy entró bajo una tarifa que no tenía este escalón y no
-- corresponde aplicárselo al salir — para eso existe el snapshot. El motor trata
-- el NULL como "esta tarifa no tiene media estadía" y saltea el tramo de 12h.
ALTER TABLE entries
  ADD COLUMN IF NOT EXISTS rate_snapshot_media_estadia_price_ars numeric(12,2);

COMMENT ON COLUMN entries.rate_snapshot_media_estadia_price_ars IS
  'Tope de 12h congelado al ingreso. NULL = la tarifa vigente al ingresar no '
  'tenía escalón de media estadía; el cobro lo saltea.';
