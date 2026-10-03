-- Quién fue la persona que canceló o rechazó una reserva.
--
-- `cancelled_by` sigue diciendo el LADO (`driver` | `owner` | `system`), donde
-- `owner` significa "el estacionamiento" (dueño u operador). Esta columna
-- guarda la persona concreta: el conductor, el dueño o el operador. Queda en
-- NULL cuando lo hizo el sistema (vencimiento de la aprobación, pago tardío sin
-- cupo) y cuando la persona se borró (`ON DELETE SET NULL`: el historial de la
-- reserva sobrevive a la baja del usuario). El rol que tenía y el detalle de
-- cada acción están en `audit_log` (`metadata.actorRole`).

ALTER TABLE reservations
    ADD COLUMN cancelled_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN reservations.cancelled_by IS
    'Lado que canceló: driver | owner (el estacionamiento: dueño u operador) | system.';
COMMENT ON COLUMN reservations.cancelled_by_user_id IS
    'Persona que canceló o rechazó (conductor, dueño u operador); NULL si fue el sistema.';
