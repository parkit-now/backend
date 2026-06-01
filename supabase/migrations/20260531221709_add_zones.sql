-- Zones — TENANT-LOCAL table (initial configuration of a lot/branch).
--
-- A zone groups parking spots by vehicle type (car/motorcycle/bicycle) as
-- counts. The individual spot is operational and out of scope here: this only
-- models the configuration (how many spots of each type per zone).
--
-- Tenant isolation works like `entries` (see 20260507022857): RLS by
-- `app_metadata.tenant_id` at the DB layer + the `prismaForTenant` extension at
-- the app layer (register 'zone' in TENANT_MODELS).

CREATE TABLE zones (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name              text NOT NULL,
    car_spots         integer NOT NULL DEFAULT 0,
    motorcycle_spots  integer NOT NULL DEFAULT 0,
    bicycle_spots     integer NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX zones_tenant_id_idx ON zones (tenant_id);

ALTER TABLE zones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON zones FROM anon;

-- Authenticated users only reach rows from their active tenant
-- (`app_metadata.tenant_id` in the JWT). The service role still bypasses RLS.
CREATE POLICY zones_select_same_tenant ON zones
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY zones_insert_same_tenant ON zones
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY zones_update_same_tenant ON zones
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    )
    WITH CHECK (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY zones_delete_same_tenant ON zones
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );
