-- Add global catalog table `vehicles` and tenant-local business table `entries`.
-- This aligns SQL with:
--   - prisma/schema/global/vehicles.prisma
--   - prisma/schema/tenant/entries.prisma

-- =========================================================================
-- vehicles (global catalog)
-- =========================================================================

CREATE TABLE vehicles (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    brand      text NOT NULL,
    model      text NOT NULL,
    type       text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON vehicles FROM anon, authenticated;
-- Backend-only for now: no policies on purpose.

-- =========================================================================
-- entries (tenant-local)
-- =========================================================================

CREATE TABLE entries (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plate       varchar(10) NOT NULL,
    color       varchar(50),
    entered_at  timestamptz NOT NULL DEFAULT now(),
    left_at     timestamptz,
    amount_paid numeric(10, 2),
    vehicle_id  uuid NOT NULL REFERENCES vehicles(id),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX entries_tenant_id_idx ON entries (tenant_id);
CREATE INDEX entries_vehicle_id_idx ON entries (vehicle_id);
CREATE INDEX entries_entered_at_idx ON entries (entered_at);

ALTER TABLE entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON entries FROM anon;

-- Authenticated users can access only rows from their active tenant context
-- (`app_metadata.tenant_id` in JWT). Service role still bypasses RLS.
CREATE POLICY entries_select_same_tenant ON entries
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY entries_insert_same_tenant ON entries
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY entries_update_same_tenant ON entries
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    )
    WITH CHECK (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY entries_delete_same_tenant ON entries
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );
