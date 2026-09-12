-- Configurable LPR image retention (SCRUM-185).
--
-- Owners can set how long a `registered` LPR detection image is kept after the
-- stay exit before the daily retention job purges it. Only this tier is
-- configurable; the noise/archived floors stay fixed in code.
--
-- A closed set of options (30/60/90), not a free range: privacy-by-design
-- calls for a short, defensible default plus a handful of vetted values, not
-- a knob any owner can push to an arbitrary ceiling with no documented
-- reason. Keeping a specific plate's evidence longer for an actual dispute is
-- a separate, per-event legal-hold concern (not built yet) — never "raise the
-- whole tenant's window". Default 30 (short, defensible; see
-- ADR-LPR-image-retention-policy.md for the 30/60/90 vs. free-range call);
-- existing rows adopt it via the column DEFAULT.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS lpr_image_retention_days smallint NOT NULL DEFAULT 30;

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_lpr_image_retention_days_range;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_lpr_image_retention_days_range
  CHECK (lpr_image_retention_days IN (30, 60, 90));

COMMENT ON COLUMN tenants.lpr_image_retention_days IS
  'Days a `registered` LPR detection image is kept after the stay exit before '
  'the retention job purges it. Owner-configurable, one of 30/60/90, default '
  '90. The noise and archived retention tiers are not affected by this value.';
