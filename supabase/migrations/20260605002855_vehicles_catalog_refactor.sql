-- Refactor vehicles into a pure brand/model catalog (no plate).
-- Refactor entries to carry vehicle_brand/model as text columns (no FK).
--
-- Changes:
--   1. vehicles: drop plate, change type to enum, add tenant_id + sync fields
--   2. entries:  add vehicle_brand/vehicle_model columns, backfill from join,
--                drop vehicle_id FK and column

-- ─── 1. vehicles ────────────────────────────────────────────────────────────

-- Vehicle type enum
CREATE TYPE vehicle_type AS ENUM (
  'auto', 'pickup', 'suv', 'van', 'moto', 'camioneta', 'otro'
);

-- Drop plate (it lives on entries, not on the catalog)
ALTER TABLE vehicles DROP COLUMN IF EXISTS plate;

-- Add tenant scope (NULL = global/admin, UUID = tenant-specific)
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

-- Migrate free-text type to enum (silently drop unrecognized values)
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS type_new vehicle_type;
UPDATE vehicles
  SET type_new = type::vehicle_type
  WHERE type IN ('auto','pickup','suv','van','moto','camioneta','otro');
ALTER TABLE vehicles DROP COLUMN IF EXISTS type;
ALTER TABLE vehicles RENAME COLUMN type_new TO type;

-- Sync fields (same pattern as rates / payment_methods)
CREATE SEQUENCE IF NOT EXISTS vehicles_sync_seq;

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS sync_seq   INTEGER     NOT NULL DEFAULT nextval('vehicles_sync_seq'),
  ADD COLUMN IF NOT EXISTS version    INTEGER     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Assign real sync_seq values to any existing rows that got DEFAULT 0
UPDATE vehicles SET sync_seq = nextval('vehicles_sync_seq') WHERE sync_seq = 0;

CREATE OR REPLACE FUNCTION set_vehicles_sync_fields()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  NEW.sync_seq   := nextval('vehicles_sync_seq');
  NEW.version    := OLD.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER vehicles_before_update
BEFORE UPDATE ON vehicles
FOR EACH ROW
EXECUTE FUNCTION set_vehicles_sync_fields();

CREATE INDEX IF NOT EXISTS vehicles_sync_seq_idx  ON vehicles(sync_seq);
CREATE INDEX IF NOT EXISTS vehicles_tenant_id_idx ON vehicles(tenant_id);

-- ─── 2. entries ─────────────────────────────────────────────────────────────

-- Add brand/model as text snapshot on the entry row
ALTER TABLE entries
  ADD COLUMN IF NOT EXISTS vehicle_brand VARCHAR(120),
  ADD COLUMN IF NOT EXISTS vehicle_model VARCHAR(120);

-- Backfill from existing vehicle relation
UPDATE entries e
  SET vehicle_brand = v.brand,
      vehicle_model = v.model
  FROM vehicles v
  WHERE e.vehicle_id = v.id;

-- Drop the FK constraint then the column
ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_vehicle_id_fkey;
ALTER TABLE entries DROP COLUMN IF EXISTS vehicle_id;
