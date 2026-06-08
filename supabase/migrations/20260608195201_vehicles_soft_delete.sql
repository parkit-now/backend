-- Add soft-delete support to vehicles.
-- When deleted_at is set the existing set_vehicles_sync_fields trigger fires
-- (it triggers on any UPDATE), bumping sync_seq so clients pick up the deletion
-- on the next incremental pull.

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;
