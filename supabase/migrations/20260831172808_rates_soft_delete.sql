-- Restore soft-delete support on rates so deletions reach offline clients.
--
-- Mirrors 20260608195201_vehicles_soft_delete.sql: the existing
-- set_rates_update_fields trigger fires on any UPDATE (see
-- 20260529093000_add_rates.sql), so stamping deleted_at bumps sync_seq and the
-- row keeps flowing through GET /tenants/:tenantId/rates/changes as a
-- tombstone. Without it a hard-deleted rate simply stops being mentioned and
-- the desktop client — which only ever bulkPuts — keeps it forever.
--
-- This reverts 20260603223052_remove_deleted_at_from_rates.sql, but on
-- different grounds: the column is not here to hide rows from a listing, it is
-- the only way the sync protocol can communicate a deletion.
--
-- ADD COLUMN is DDL and does not fire the row trigger, so existing rows keep
-- their sync_seq: no spurious full resync.

ALTER TABLE rates
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

-- A soft-deleted rate must release its shortcut number, otherwise it would
-- occupy it forever. Recreate the partial unique index from
-- 20260608200000_rates_shortcut_number.sql with deleted_at accounted for.
DROP INDEX IF EXISTS rates_tenant_shortcut_number_idx;

CREATE UNIQUE INDEX rates_tenant_shortcut_number_idx
  ON rates(tenant_id, shortcut_number)
  WHERE shortcut_number IS NOT NULL AND deleted_at IS NULL;
