-- Add shortcut_number to rates: lets operators type a number to quickly find a rate in the entry form.
-- Nullable so existing rates are unaffected. Partial unique index allows multiple NULLs.

ALTER TABLE rates ADD COLUMN shortcut_number INTEGER NULL;

CREATE UNIQUE INDEX rates_tenant_shortcut_number_idx
  ON rates(tenant_id, shortcut_number)
  WHERE shortcut_number IS NOT NULL;
