-- Add tenant-local rate catalog table.
-- Replaces legacy Access table `tasas` at schema level (no data import here).

-- =========================================================================
-- rates (tenant-local)
-- =========================================================================

CREATE SEQUENCE rates_sync_seq;

CREATE TABLE rates (
    id                 uuid PRIMARY KEY,
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name               varchar(120) NOT NULL,
    hour_price_ars     numeric(12, 2) NOT NULL CHECK (hour_price_ars >= 0),
    stay_price_ars     numeric(12, 2) NOT NULL CHECK (stay_price_ars >= 0),
    fraction_price_ars numeric(12, 2) NOT NULL CHECK (fraction_price_ars >= 0),
    is_active          boolean NOT NULL DEFAULT true,
    version            integer NOT NULL DEFAULT 1,
    sync_seq           integer NOT NULL DEFAULT nextval('rates_sync_seq'),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    deleted_at         timestamptz
);

CREATE INDEX rates_tenant_id_idx ON rates (tenant_id);
CREATE INDEX rates_tenant_sync_seq_idx ON rates (tenant_id, sync_seq);
CREATE INDEX rates_tenant_updated_at_idx ON rates (tenant_id, updated_at);

CREATE OR REPLACE FUNCTION set_rates_update_fields()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    NEW.sync_seq := nextval('rates_sync_seq');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rates_before_update
BEFORE UPDATE ON rates
FOR EACH ROW
EXECUTE FUNCTION set_rates_update_fields();

ALTER TABLE rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON rates FROM anon;

-- Authenticated users can access only rows from their active tenant context
-- (`app_metadata.tenant_id` in JWT). Service role still bypasses RLS.
CREATE POLICY rates_select_same_tenant ON rates
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY rates_insert_same_tenant ON rates
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY rates_update_same_tenant ON rates
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    )
    WITH CHECK (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

CREATE POLICY rates_delete_same_tenant ON rates
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );
