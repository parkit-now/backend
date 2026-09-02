-- Configurable LPR image retention (SCRUM-185).
--
-- Owners can set how long a `registered` LPR detection image is kept after the
-- stay exit before the daily retention job purges it. Only this tier is
-- configurable; the noise/archived floors stay fixed in code.
--
-- Bounded on purpose: a too-short value defeats the compliance goal, a
-- too-long one keeps personal data (and storage cost) around with no reason.
-- Default 90 matches ADR-LPR-image-retention-policy.md; existing rows adopt it
-- via the column DEFAULT.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS lpr_image_retention_days smallint NOT NULL DEFAULT 90;

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_lpr_image_retention_days_range;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_lpr_image_retention_days_range
  CHECK (lpr_image_retention_days BETWEEN 30 AND 365);

COMMENT ON COLUMN tenants.lpr_image_retention_days IS
  'Days a `registered` LPR detection image is kept after the stay exit before '
  'the retention job purges it. Owner-configurable, 30-365, default 90. The '
  'noise and archived retention tiers are not affected by this value.';
