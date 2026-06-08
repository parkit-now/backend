-- Tenant-local configuration: weekly opening hours (schedules) and the set of
-- services/amenities a parking lot offers (services).
--
-- Both tables follow the canonical tenant-local pattern (see
-- 20260529093000_add_rates.sql): tenant_id FK, offline-sync fields
-- (sync_seq/version/updated_at) + BEFORE UPDATE trigger, and RLS policies
-- scoped to the active tenant. Rows are created from the web admin, so `id`
-- is database-generated (no client UUIDv7 needed).

-- =========================================================================
-- enums
-- =========================================================================

CREATE TYPE schedule_day AS ENUM (
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday'
);

CREATE TYPE service_code AS ENUM (
    'ADVANCE_RESERVATION',
    'VEHICLE_CAR',
    'VEHICLE_BICYCLE',
    'VEHICLE_MOTORCYCLE',
    'VEHICLE_PICKUP',
    'VEHICLE_TRUCK'
);

-- =========================================================================
-- schedules (tenant-local) — one row per opening time range of a weekday.
-- A day may have several non-overlapping ranges ("de corrido" = one range,
-- "por partes" = several). Overlap is enforced in the application layer.
-- =========================================================================

CREATE SEQUENCE schedules_sync_seq;

-- open_minute/close_minute are minutes since midnight (0..1440). Using integers
-- (instead of `time`) keeps overlap math trivial and avoids Prisma's
-- DateTime<->time-of-day timezone quirks. close_minute = 1440 means midnight
-- (a range "de corrido" 00:00–24:00 covers the whole day).
CREATE TABLE schedules (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    day           schedule_day NOT NULL,
    open_minute   integer NOT NULL,
    close_minute  integer NOT NULL,
    version       integer NOT NULL DEFAULT 1,
    sync_seq      integer NOT NULL DEFAULT nextval('schedules_sync_seq'),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schedules_open_range CHECK (open_minute >= 0 AND open_minute < 1440),
    CONSTRAINT schedules_close_range CHECK (close_minute > 0 AND close_minute <= 1440),
    CONSTRAINT schedules_time_order CHECK (close_minute > open_minute)
);

CREATE INDEX schedules_tenant_id_idx ON schedules (tenant_id);
CREATE INDEX schedules_tenant_day_idx ON schedules (tenant_id, day);
CREATE INDEX schedules_tenant_sync_seq_idx ON schedules (tenant_id, sync_seq);
CREATE INDEX schedules_tenant_updated_at_idx ON schedules (tenant_id, updated_at);

CREATE OR REPLACE FUNCTION set_schedules_update_fields()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    NEW.sync_seq := nextval('schedules_sync_seq');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER schedules_before_update
BEFORE UPDATE ON schedules
FOR EACH ROW
EXECUTE FUNCTION set_schedules_update_fields();

ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON schedules FROM anon;

CREATE POLICY schedules_select_same_tenant ON schedules
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY schedules_insert_same_tenant ON schedules
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY schedules_update_same_tenant ON schedules
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    )
    WITH CHECK (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY schedules_delete_same_tenant ON schedules
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

-- =========================================================================
-- services (tenant-local) — per-tenant toggle of a known service_code.
-- The full catalog lives in the `service_code` enum; a row exists only for
-- codes the tenant has touched. GET merges enum defaults with stored rows.
-- =========================================================================

CREATE SEQUENCE services_sync_seq;

CREATE TABLE services (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code        service_code NOT NULL,
    enabled     boolean NOT NULL DEFAULT false,
    -- Number of spots assigned to this vehicle type (0 for non-vehicle codes
    -- such as ADVANCE_RESERVATION). Replaces tenants.settings.capacity.
    spots       integer NOT NULL DEFAULT 0 CHECK (spots >= 0),
    version     integer NOT NULL DEFAULT 1,
    sync_seq    integer NOT NULL DEFAULT nextval('services_sync_seq'),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT services_tenant_code_unique UNIQUE (tenant_id, code)
);

CREATE INDEX services_tenant_id_idx ON services (tenant_id);
CREATE INDEX services_tenant_sync_seq_idx ON services (tenant_id, sync_seq);
CREATE INDEX services_tenant_updated_at_idx ON services (tenant_id, updated_at);

CREATE OR REPLACE FUNCTION set_services_update_fields()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    NEW.sync_seq := nextval('services_sync_seq');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER services_before_update
BEFORE UPDATE ON services
FOR EACH ROW
EXECUTE FUNCTION set_services_update_fields();

ALTER TABLE services ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON services FROM anon;

CREATE POLICY services_select_same_tenant ON services
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY services_insert_same_tenant ON services
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY services_update_same_tenant ON services
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    )
    WITH CHECK (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY services_delete_same_tenant ON services
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

-- Backfill: migrate the per-type capacity that used to live in
-- tenants.settings.capacity (carSpots/motorcycleSpots/bicycleSpots) into
-- services rows. A type is enabled when it had at least one spot.
INSERT INTO services (tenant_id, code, enabled, spots)
SELECT
    t.id,
    v.code::service_code,
    COALESCE((t.settings -> 'capacity' ->> v.key)::int, 0) > 0,
    COALESCE((t.settings -> 'capacity' ->> v.key)::int, 0)
FROM tenants t
CROSS JOIN (VALUES
    ('VEHICLE_CAR', 'carSpots'),
    ('VEHICLE_MOTORCYCLE', 'motorcycleSpots'),
    ('VEHICLE_BICYCLE', 'bicycleSpots')
) AS v(code, key)
WHERE t.settings -> 'capacity' ->> v.key IS NOT NULL
ON CONFLICT (tenant_id, code) DO NOTHING;
