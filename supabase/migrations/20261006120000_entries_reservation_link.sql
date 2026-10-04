-- El ingreso queda vinculado a la reserva con la que entró el auto (fase 6).
--
-- POR QUÉ
--
-- El conductor ya pagó la reserva por Mercado Pago. Cuando llega, la caja
-- registra el ingreso como siempre y, al salir, tiene que cobrar SOLO el
-- excedente: `max(calcStayPrice(total) − prepagado, 0)`. Para eso el ingreso
-- tiene que saber qué reserva lo cubre y cuánto se pagó por adelantado.
--
-- QUÉ HACE
--
--   `reservation_id`      uuid NULL, FK a `reservations` con ON DELETE SET NULL.
--                         Lo escribe SIEMPRE el backend al crear el ingreso
--                         (vínculo por `reservationId` o por patente), nunca
--                         el cliente a ciegas, así que la FK no puede rechazar
--                         un ingreso con plata. UNIQUE: una reserva cubre a lo
--                         sumo un ingreso (los NULL no chocan entre sí).
--   `prepaid_amount_ars`  numeric(12,2) NULL. Lo que el conductor pagó por
--                         adelantado, congelado al vincular (snapshot, igual
--                         que la tarifa). La caja lo descuenta al cobrar.
--
-- COMPATIBILIDAD (expand/contract)
--
-- Las dos columnas son NULL y sin default: un backend viejo las ignora y un
-- desktop viejo no las manda. Postgres no reescribe la tabla y no dispara
-- `entries_before_update`, así que no hay tráfico de sync ni cambia la
-- `version` de ningún ingreso (una caja offline con un cierre encolado no se
-- entera). La FK se agrega NOT VALID y se valida aparte: todas las filas son
-- NULL, alcanza con un lock liviano.

ALTER TABLE entries
    ADD COLUMN reservation_id     uuid,
    ADD COLUMN prepaid_amount_ars numeric(12, 2);

ALTER TABLE entries
    ADD CONSTRAINT entries_reservation_id_fkey
    FOREIGN KEY (reservation_id) REFERENCES reservations(id)
    ON DELETE SET NULL
    NOT VALID;

ALTER TABLE entries VALIDATE CONSTRAINT entries_reservation_id_fkey;

ALTER TABLE entries
    ADD CONSTRAINT entries_prepaid_amount_ars_non_negative
    CHECK (prepaid_amount_ars IS NULL OR prepaid_amount_ars >= 0);

CREATE UNIQUE INDEX entries_reservation_id_key ON entries (reservation_id);

COMMENT ON COLUMN entries.reservation_id IS
  'Reserva con la que entró el auto. La escribe el backend al crear el ingreso '
  '(por reservationId o por patente). NULL en los ingresos sin reserva.';
COMMENT ON COLUMN entries.prepaid_amount_ars IS
  'Lo que el conductor pagó por adelantado con la reserva (snapshot al '
  'vincular). La caja cobra max(estadía − prepagado, 0).';
