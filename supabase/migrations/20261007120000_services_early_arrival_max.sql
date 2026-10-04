-- Llegada anticipada con tope por estacionamiento (fase 6c de reservas).
--
-- POR QUÉ
--
-- Hasta ahora un auto que llegaba antes de `entryAt − early_arrival_minutes`
-- entraba como estadía común y la reserva quedaba colgada (después, no-show).
-- El dueño decide cuánto antes se lo deja entrar CON la reserva: dentro de ese
-- tope el ingreso se vincula solo, se marca "llegó antes" y el tiempo extra se
-- cobra como excedente al salir (`calcStayPrice(estadía real) − prepago`).
-- Más temprano que el tope, o una reserva de otro día, no se vincula.
--
-- QUÉ HACE
--
--   `services.early_arrival_max_minutes` integer NOT NULL DEFAULT 60, con
--   CHECK 0..1440 (un día). Lo lee sólo ADVANCE_RESERVATION; en otros códigos
--   el default es inocuo, igual que el resto de las reglas (20261003120000).
--
--   No hay CHECK contra `early_arrival_minutes`: una playa que ya tenía 90 de
--   llegada anticipada quedaría inválida con el default. La API valida que el
--   tope no sea menor cuando el dueño toca alguno de los dos, y el check-in usa
--   el mayor de ambos.
--
-- COMPATIBILIDAD (expand/contract)
--
-- Columna con default constante: Postgres no reescribe la tabla y un backend
-- viejo la ignora. `services` tiene trigger de sync, pero un ADD COLUMN no lo
-- dispara: no hay tráfico de sync ni cambia la `version` de ninguna fila.
-- Las reservas guardan el tope en `policy_snapshot.earlyArrivalMaxMinutes` al
-- crearse; las anteriores a esta migración no lo tienen y usan el valor vivo
-- del servicio.

ALTER TABLE services
  ADD COLUMN early_arrival_max_minutes integer NOT NULL DEFAULT 60;

ALTER TABLE services
  ADD CONSTRAINT services_early_arrival_max_range CHECK (
    early_arrival_max_minutes BETWEEN 0 AND 1440
  );

COMMENT ON COLUMN services.early_arrival_max_minutes IS
  'ADVANCE_RESERVATION: hasta cuántos minutos antes de la hora de ingreso un '
  'auto que llega se vincula a su reserva ("llegó antes"; el extra se cobra '
  'como excedente). Antes de eso entra como estadía común.';
