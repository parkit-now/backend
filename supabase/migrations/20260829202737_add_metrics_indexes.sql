-- Indexes backing the owner revenue dashboard (`/tenants/:id/metrics/*`).
--
-- Every metrics query filters by tenant first and then by a time range or a
-- plate, but no existing index serves those shapes:
--
--   * `entries_entered_at_idx` covers `entered_at` alone, without `tenant_id`,
--     so a per-tenant range still scans other tenants' rows.
--   * There was NO index on `left_at` at all — the column the whole revenue
--     series filters on, since payments carry no timestamp of their own and
--     revenue is attributed at exit time.
--   * `entries_tenant_plate_active_idx` is PARTIAL (`WHERE left_at IS NULL`),
--     built for LPR duplicate detection on active stays. The top-plates report
--     aggregates *closed* stays, which that index cannot serve.
--
-- Read-only additions: no column, constraint, or data changes.

-- Revenue series, top-plates and the payment-method breakdown: closed stays in
-- a range. Leading `tenant_id` matches the WHERE that `prismaForTenant`
-- injects on every read.
CREATE INDEX entries_tenant_left_at_idx
    ON entries (tenant_id, left_at);

-- "Vehicles that entered" series, anchored on `entered_at` rather than
-- `left_at` (a stay is counted on the day it arrived, paid on the day it left).
CREATE INDEX entries_tenant_entered_at_idx
    ON entries (tenant_id, entered_at);

-- Top-plates grouping. Non-partial on purpose, unlike
-- `entries_tenant_plate_active_idx`: this one has to reach closed stays.
CREATE INDEX entries_tenant_plate_idx
    ON entries (tenant_id, plate);
