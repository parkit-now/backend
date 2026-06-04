-- Add sync fields, optimistic locking, and rate snapshot to entries.
-- Prepares entries for offline-first desktop sync (syncSeq + version + updatedAt)
-- and captures the selected rate at vehicle entry time (snapshot fields).

-- =========================================================================
-- entries: sync + optimistic locking + updatedAt
-- =========================================================================

-- Change primary key to be client-provided (UUIDv7) — remove server default
ALTER TABLE entries ALTER COLUMN id DROP DEFAULT;

-- Sync sequence (mirrors rates_sync_seq pattern)
CREATE SEQUENCE entries_sync_seq;

ALTER TABLE entries
  ADD COLUMN sync_seq   integer    NOT NULL DEFAULT nextval('entries_sync_seq'),
  ADD COLUMN version    integer    NOT NULL DEFAULT 1,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Assign syncSeq on INSERT (DEFAULT handles it) and bump on UPDATE
CREATE OR REPLACE FUNCTION set_entries_sync_fields()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    NEW.sync_seq   := nextval('entries_sync_seq');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entries_before_update
BEFORE UPDATE ON entries
FOR EACH ROW
EXECUTE FUNCTION set_entries_sync_fields();

CREATE INDEX entries_tenant_sync_seq_idx  ON entries (tenant_id, sync_seq);
CREATE INDEX entries_tenant_updated_at_idx ON entries (tenant_id, updated_at);

-- =========================================================================
-- entries: rate snapshot
-- Captured at vehicle entry time so later rate edits don't affect in-progress stays.
-- =========================================================================

ALTER TABLE entries
  ADD COLUMN rate_id                        uuid        REFERENCES rates(id) ON DELETE SET NULL,
  ADD COLUMN rate_snapshot_name             varchar(120),
  ADD COLUMN rate_snapshot_hour_price_ars   numeric(12, 2),
  ADD COLUMN rate_snapshot_stay_price_ars   numeric(12, 2),
  ADD COLUMN rate_snapshot_fraction_price_ars numeric(12, 2);

CREATE INDEX entries_rate_id_idx ON entries (rate_id);
