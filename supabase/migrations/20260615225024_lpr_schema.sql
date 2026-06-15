-- US-005 / SCRUM-88: LPR auto-entry schema
--
-- Two changes:
--   1. Extend `entries` with LPR-specific fields (source, vehicle_type, image URLs,
--      camera IDs, whitelist FK) and an index for active-stay duplicate detection.
--   2. New `whitelists` table — tenant-local, sync-enabled, RLS-protected.

-- =========================================================================
-- entries: LPR fields
-- vehicle_type reuses the existing enum from 20260605002855_vehicles_catalog_refactor.sql
-- =========================================================================

-- source distinguishes operator-typed entries from automatic LPR ones.
-- Default 'manual' keeps all existing rows valid without a backfill.
ALTER TABLE entries
    ADD COLUMN source           varchar(10)  NOT NULL DEFAULT 'manual',
    ADD COLUMN vehicle_type     vehicle_type,
    ADD COLUMN entry_image_url  text,
    ADD COLUMN entry_camera_id  varchar(100),
    ADD COLUMN exit_image_url   text,
    ADD COLUMN exit_camera_id   varchar(100),
    ADD COLUMN whitelist_id     uuid;

-- Partial index: only indexes active stays (left_at IS NULL).
-- This is the hot path for duplicate detection in createStayFromLprEvent().
CREATE INDEX entries_tenant_plate_active_idx
    ON entries (tenant_id, plate)
    WHERE left_at IS NULL;

-- =========================================================================
-- whitelists (tenant-local, sync-enabled)
-- One row per authorized plate. valid_from/valid_until are both nullable:
--   NULL valid_from  = valid from the beginning of time
--   NULL valid_until = never expires
-- =========================================================================

CREATE SEQUENCE whitelists_sync_seq;

CREATE TABLE whitelists (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    plate         varchar(20) NOT NULL,
    valid_from    timestamptz,
    valid_until   timestamptz,
    notes         text,
    version       integer     NOT NULL DEFAULT 1,
    sync_seq      integer     NOT NULL DEFAULT nextval('whitelists_sync_seq'),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX whitelists_tenant_id_idx         ON whitelists (tenant_id);
CREATE INDEX whitelists_tenant_plate_idx      ON whitelists (tenant_id, plate);
CREATE INDEX whitelists_tenant_sync_seq_idx   ON whitelists (tenant_id, sync_seq);
CREATE INDEX whitelists_tenant_updated_at_idx ON whitelists (tenant_id, updated_at);

CREATE OR REPLACE FUNCTION set_whitelists_sync_fields()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    NEW.sync_seq   := nextval('whitelists_sync_seq');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER whitelists_before_update
BEFORE UPDATE ON whitelists
FOR EACH ROW
EXECUTE FUNCTION set_whitelists_sync_fields();

-- FK from entries.whitelist_id — added after the table exists
ALTER TABLE entries
    ADD CONSTRAINT entries_whitelist_id_fkey
    FOREIGN KEY (whitelist_id) REFERENCES whitelists(id) ON DELETE SET NULL;

CREATE INDEX entries_whitelist_id_idx ON entries (whitelist_id)
    WHERE whitelist_id IS NOT NULL;

-- =========================================================================
-- RLS
-- =========================================================================

ALTER TABLE whitelists ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON whitelists FROM anon;
