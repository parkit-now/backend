-- Cash register sessions (cash_sessions) and per-exit payment breakdown
-- (payment_transactions).
--
-- cash_sessions: tenant-local, one active session at a time per tenant.
-- Tracks the opening float, optional leaving float for the next shift,
-- and the open/close timestamps.
--
-- payment_transactions: tenant-local, one row per payment method used on
-- a single vehicle exit. Created atomically with the entry close so the
-- cash session summary is always consistent.
--
-- Both tables follow the canonical tenant-local pattern:
-- client UUIDv7 primary key, syncSeq + version + updated_at + BEFORE trigger,
-- and RLS policies scoped to the active tenant.

-- =========================================================================
-- cash_sessions
-- =========================================================================

CREATE SEQUENCE cash_sessions_sync_seq;

CREATE TABLE cash_sessions (
    id            uuid        PRIMARY KEY,   -- UUIDv7 from client
    tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    opened_at     timestamptz NOT NULL DEFAULT now(),
    closed_at     timestamptz,              -- NULL = currently open
    opening_cash  numeric(12, 2) NOT NULL DEFAULT 0,
    leaving_cash  numeric(12, 2),           -- cash left for the next shift
    notes         text,
    version       integer     NOT NULL DEFAULT 1,
    sync_seq      integer     NOT NULL DEFAULT nextval('cash_sessions_sync_seq'),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Only one open session per tenant at a time.
CREATE UNIQUE INDEX cash_sessions_tenant_open_idx
    ON cash_sessions (tenant_id)
    WHERE closed_at IS NULL;

CREATE INDEX cash_sessions_tenant_id_idx       ON cash_sessions (tenant_id);
CREATE INDEX cash_sessions_tenant_sync_seq_idx ON cash_sessions (tenant_id, sync_seq);
CREATE INDEX cash_sessions_tenant_updated_at_idx ON cash_sessions (tenant_id, updated_at);

CREATE OR REPLACE FUNCTION set_cash_sessions_sync_fields()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    NEW.sync_seq   := nextval('cash_sessions_sync_seq');
    IF TG_OP = 'UPDATE' THEN
        NEW.version := OLD.version + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cash_sessions_before_update
BEFORE UPDATE ON cash_sessions
FOR EACH ROW
EXECUTE FUNCTION set_cash_sessions_sync_fields();

ALTER TABLE cash_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cash_sessions FROM anon;

CREATE POLICY cash_sessions_select_same_tenant ON cash_sessions
    FOR SELECT TO authenticated
    USING (tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid);

CREATE POLICY cash_sessions_insert_same_tenant ON cash_sessions
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid);

CREATE POLICY cash_sessions_update_same_tenant ON cash_sessions
    FOR UPDATE TO authenticated
    USING  (tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid)
    WITH CHECK (tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid);

CREATE POLICY cash_sessions_delete_same_tenant ON cash_sessions
    FOR DELETE TO authenticated
    USING (tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid);

-- =========================================================================
-- payment_transactions
-- =========================================================================

CREATE SEQUENCE payment_transactions_sync_seq;

CREATE TABLE payment_transactions (
    id                   uuid           PRIMARY KEY,  -- UUIDv7 from client
    tenant_id            uuid           NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    entry_id             uuid           NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    cash_session_id      uuid           REFERENCES cash_sessions(id) ON DELETE SET NULL,
    payment_method_id    uuid,          -- nullable: PM may be deleted later
    payment_method_name  varchar(120)   NOT NULL,     -- snapshot
    amount               numeric(12, 2) NOT NULL,
    version              integer        NOT NULL DEFAULT 1,
    sync_seq             integer        NOT NULL DEFAULT nextval('payment_transactions_sync_seq'),
    updated_at           timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX payment_transactions_entry_id_idx
    ON payment_transactions (entry_id);
CREATE INDEX payment_transactions_tenant_id_idx
    ON payment_transactions (tenant_id);
CREATE INDEX payment_transactions_tenant_sync_seq_idx
    ON payment_transactions (tenant_id, sync_seq);
CREATE INDEX payment_transactions_tenant_session_idx
    ON payment_transactions (tenant_id, cash_session_id);

CREATE OR REPLACE FUNCTION set_payment_transactions_sync_fields()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    NEW.sync_seq   := nextval('payment_transactions_sync_seq');
    IF TG_OP = 'UPDATE' THEN
        NEW.version := OLD.version + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_transactions_before_update
BEFORE UPDATE ON payment_transactions
FOR EACH ROW
EXECUTE FUNCTION set_payment_transactions_sync_fields();

ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON payment_transactions FROM anon;

CREATE POLICY payment_transactions_select_same_tenant ON payment_transactions
    FOR SELECT TO authenticated
    USING (tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid);

CREATE POLICY payment_transactions_insert_same_tenant ON payment_transactions
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid);

CREATE POLICY payment_transactions_update_same_tenant ON payment_transactions
    FOR UPDATE TO authenticated
    USING  (tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid)
    WITH CHECK (tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid);

CREATE POLICY payment_transactions_delete_same_tenant ON payment_transactions
    FOR DELETE TO authenticated
    USING (tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid);

-- =========================================================================
-- entries: add cash session reference and ticket number
-- =========================================================================

ALTER TABLE entries
    ADD COLUMN cash_session_id uuid REFERENCES cash_sessions(id) ON DELETE SET NULL,
    ADD COLUMN ticket_number   integer;

CREATE INDEX entries_tenant_cash_session_idx
    ON entries (tenant_id, cash_session_id);
