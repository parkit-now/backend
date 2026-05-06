-- Drop `cuit` from `tenants`.
--
-- The original schema modeled a tenant as the B2B legal entity (one row per
-- company, identified by CUIT). The product model has shifted: a tenant now
-- represents a single parking lot, and an owner can hold several. CUIT is
-- legal-entity data, not parking-lot data, so it doesn't belong here. If/when
-- we model the legal entity (likely as `Owner`/`Company`), CUIT moves there.
--
-- DROP COLUMN cascades the implicit UNIQUE constraint on the column.

ALTER TABLE tenants DROP COLUMN IF EXISTS cuit;
