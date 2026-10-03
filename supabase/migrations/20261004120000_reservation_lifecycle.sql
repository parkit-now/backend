-- Ciclo de vida de la reserva con pago (fase 2 de reservas con Checkout Pro).
--
-- 1. ENUM v2 POR RENAME, NO POR `ALTER TYPE ... ADD VALUE`. Agregar valores a
--    un enum existente no puede usarse en la misma transacción que los agrega,
--    y acá la migración de datos (más abajo) los usa. Se crea
--    `reservation_status_v2`, se convierte la columna con `USING`, se borra el
--    tipo viejo y se renombra. Antes hay que soltar lo que depende del tipo: el
--    índice parcial de la ventana y el CHECK de `cancelled_at`.
--
-- 2. COLUMNAS NUEVAS en `reservations`: retención y pago (`hold_expires_at`,
--    `paid_at`), aceptación (`approval_deadline_at`), quién y por qué canceló
--    (`cancelled_by`, `reason`), reembolso (`refund_*`) y la foto de las reglas
--    de la playa al reservar (`policy_snapshot`). `refund_attempts` arma la
--    `idempotencyKey` del reembolso (`refund:<reservationId>:<n>`) y
--    `refund_requested_ars` guarda el monto pedido, para reintentar un
--    reembolso `failed` por el mismo valor.
--
-- 3. DATOS: las `confirmed` cuyo egreso ya pasó se marcan `completed`. Hasta
--    ahora "completada" se derivaba de la hora; desde acá se guarda.
--
-- 4. `reservation_payments` es GLOBAL (como `payment_intents`): el webhook de
--    Mercado Pago la busca sin contexto de tenant. Backend-only: RLS prendida,
--    cero policies y REVOKE para anon/authenticated.

-- ─── Enum v2 ──────────────────────────────────────────────────────────────────

DROP INDEX reservations_tenant_window_idx;
ALTER TABLE reservations DROP CONSTRAINT reservations_cancelled_consistent;

CREATE TYPE reservation_status_v2 AS ENUM (
    'pending_payment',
    'pending_approval',
    'confirmed',
    'checked_in',
    'completed',
    'cancelled',
    'rejected',
    'expired',
    'no_show'
);

ALTER TABLE reservations ALTER COLUMN status DROP DEFAULT;
ALTER TABLE reservations
    ALTER COLUMN status TYPE reservation_status_v2
    USING status::text::reservation_status_v2;
DROP TYPE reservation_status;
ALTER TYPE reservation_status_v2 RENAME TO reservation_status;
ALTER TABLE reservations ALTER COLUMN status SET DEFAULT 'confirmed';

-- ─── Columnas nuevas ──────────────────────────────────────────────────────────

ALTER TABLE reservations
    ADD COLUMN hold_expires_at timestamptz,
    ADD COLUMN paid_at timestamptz,
    ADD COLUMN approval_deadline_at timestamptz,
    ADD COLUMN cancelled_by text,
    ADD COLUMN reason text,
    ADD COLUMN refund_status text NOT NULL DEFAULT 'none',
    ADD COLUMN refunded_amount_ars numeric(12, 2),
    ADD COLUMN refund_error text,
    ADD COLUMN refund_requested_at timestamptz,
    ADD COLUMN refund_requested_ars numeric(12, 2),
    ADD COLUMN refund_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN policy_snapshot jsonb;

ALTER TABLE reservations
    ADD CONSTRAINT reservations_cancelled_by_valid CHECK (
        cancelled_by IS NULL OR cancelled_by IN ('driver', 'owner', 'system')
    ),
    ADD CONSTRAINT reservations_refund_status_valid CHECK (
        refund_status IN ('none', 'pending', 'refunded', 'partial', 'failed')
    ),
    ADD CONSTRAINT reservations_refunded_amount_non_negative CHECK (
        refunded_amount_ars IS NULL OR refunded_amount_ars >= 0
    ),
    ADD CONSTRAINT reservations_refund_requested_non_negative CHECK (
        refund_requested_ars IS NULL OR refund_requested_ars >= 0
    ),
    ADD CONSTRAINT reservations_cancelled_consistent CHECK (
        status NOT IN ('cancelled', 'rejected') OR cancelled_at IS NOT NULL
    );

-- ─── Datos ────────────────────────────────────────────────────────────────────

UPDATE reservations
   SET status = 'completed'
 WHERE status = 'confirmed' AND exit_at < now();

-- ─── Índices ──────────────────────────────────────────────────────────────────

-- Vista del dueño: listado por estado y fecha de ingreso.
CREATE INDEX reservations_tenant_status_entry_idx
    ON reservations (tenant_id, status, entry_at);

-- Sweeper: retenciones vencidas.
CREATE INDEX reservations_status_hold_idx
    ON reservations (status, hold_expires_at);

-- Cupo: reservas que retienen lugar y se superponen con una ventana.
CREATE INDEX reservations_tenant_window_idx
    ON reservations (tenant_id, entry_at, exit_at)
    WHERE status IN ('pending_payment', 'pending_approval', 'confirmed', 'checked_in');

COMMENT ON COLUMN reservations.hold_expires_at IS
  'Fin de la retención de 10 min para pagar. El cupo se libera 5 min después (margen para pagos en vuelo).';
COMMENT ON COLUMN reservations.approval_deadline_at IS
  'Modo manual: hasta cuándo puede responder el dueño. Pasado, se rechaza sola con reembolso total.';
COMMENT ON COLUMN reservations.cancelled_by IS 'driver | owner | system.';
COMMENT ON COLUMN reservations.refund_attempts IS
  'Reembolsos intentados; arma la idempotencyKey refund:<reservationId>:<n>.';
COMMENT ON COLUMN reservations.refund_requested_ars IS
  'Monto del último reembolso pedido; lo usa el reintento manual de un reembolso failed.';
COMMENT ON COLUMN reservations.policy_snapshot IS
  'Reglas de la playa al reservar (cancelación, llegada, tolerancia, aceptación).';

-- ─── reservation_payments ─────────────────────────────────────────────────────

CREATE TYPE reservation_payment_status AS ENUM (
    'created',
    'approved',
    'rejected',
    'cancelled',
    'refunded',
    'partially_refunded'
);

CREATE TABLE reservation_payments (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id           uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    amount_ars               numeric(12, 2) NOT NULL,
    status                   reservation_payment_status NOT NULL DEFAULT 'created',
    provider                 text NOT NULL DEFAULT 'mercado_pago',
    provider_preference_id   text,
    checkout_url             text,
    provider_payment_id      text,
    provider_status          text,
    provider_status_detail   text,
    return_url               text,
    approved_at              timestamptz,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reservation_payments_amount_non_negative CHECK (amount_ars >= 0)
);

-- Un solo pago VIVO por reserva: evita el doble cobro ante un doble toque o
-- un reintento. `rejected` y `cancelled` liberan el lugar para un pago nuevo.
CREATE UNIQUE INDEX reservation_payments_reservation_live_idx
    ON reservation_payments (reservation_id)
    WHERE status IN ('created', 'approved');

CREATE UNIQUE INDEX reservation_payments_provider_payment_id_key
    ON reservation_payments (provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;

CREATE INDEX reservation_payments_tenant_idx
    ON reservation_payments (tenant_id);

CREATE OR REPLACE FUNCTION set_reservation_payments_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reservation_payments_before_update
BEFORE UPDATE ON reservation_payments
FOR EACH ROW
EXECUTE FUNCTION set_reservation_payments_updated_at();

ALTER TABLE reservation_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON reservation_payments FROM anon, authenticated;
-- Sin policies a propósito: solo el service_role saltea RLS.

COMMENT ON TABLE reservation_payments IS
  'Pagos de reservas (Checkout Pro). Global: el webhook busca sin tenant. Backend-only (RLS sin policies).';
