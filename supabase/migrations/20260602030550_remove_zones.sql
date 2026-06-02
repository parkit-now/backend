-- Remove the `zones` table.
--
-- The "zone" concept is dropped from the product: a parking lot no longer
-- groups spots into zones. Per-type spot capacity (car/motorcycle/bicycle) now
-- lives in `tenants.settings` (JSON, key `capacity`), set on onboarding
-- approval and editable by the owner from the web panel.
--
-- DROP ... CASCADE also removes the RLS policies, the `zones_tenant_id_idx`
-- index and the FK from `tenants`. No data migration: the previous zone counts
-- are re-declared via the onboarding/config flows.

DROP TABLE IF EXISTS zones CASCADE;
