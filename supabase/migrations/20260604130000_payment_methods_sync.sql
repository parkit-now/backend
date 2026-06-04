-- Sync infrastructure for payment_methods so the desktop can pull incremental
-- changes and create/update custom methods while offline.

CREATE SEQUENCE IF NOT EXISTS payment_methods_sync_seq;

ALTER TABLE payment_methods
  ADD COLUMN IF NOT EXISTS sync_seq   INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS version    INTEGER     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill existing rows so they show up on the first pullChanges(afterSeq=0).
UPDATE payment_methods
SET sync_seq = nextval('payment_methods_sync_seq')
WHERE sync_seq = 0;

CREATE OR REPLACE FUNCTION set_payment_methods_sync_fields()
RETURNS TRIGGER AS $$
BEGIN
  NEW.sync_seq   := nextval('payment_methods_sync_seq');
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_methods_before_insert
  BEFORE INSERT ON payment_methods
  FOR EACH ROW EXECUTE FUNCTION set_payment_methods_sync_fields();

CREATE TRIGGER payment_methods_before_update
  BEFORE UPDATE ON payment_methods
  FOR EACH ROW EXECUTE FUNCTION set_payment_methods_sync_fields();

-- Replace the global unique on (tenant_id, type) with a partial index that only
-- enforces uniqueness for system methods (cash, mp_transfer).  Custom methods
-- can coexist in any number under the same type.
ALTER TABLE payment_methods
  DROP CONSTRAINT IF EXISTS payment_methods_tenant_id_type_key;

CREATE UNIQUE INDEX IF NOT EXISTS payment_methods_tenant_system_type_idx
  ON payment_methods (tenant_id, type)
  WHERE is_system = true;

CREATE INDEX IF NOT EXISTS payment_methods_tenant_sync_seq_idx
  ON payment_methods (tenant_id, sync_seq);

CREATE INDEX IF NOT EXISTS payment_methods_tenant_updated_at_idx
  ON payment_methods (tenant_id, updated_at);
