-- Parkit — initial schema
-- Two tables:
--   * tenants  — one row per parking lot (B2B customer). No RLS; only the
--                backend service role touches it.
--   * users    — extends Supabase Auth users with a tenant_id and an app role.
--                RLS isolates rows by tenant_id, read from the JWT app_metadata.
--
-- Row-level security is the *second* line of defense. The first is the
-- prismaForTenant() extension in src/database/prisma-tenant.ts. Both must
-- agree for cross-tenant access to be possible — which it should never be.

-- =========================================================================
-- Enums
-- =========================================================================

CREATE TYPE user_role AS ENUM (
    'admin',     -- full tenant access
    'owner',     -- parking-lot owner
    'operator',  -- booth operator (limited UI)
    'driver'     -- mobile-app end user
);

-- =========================================================================
-- Tenants
-- =========================================================================

CREATE TABLE tenants (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre     text NOT NULL,
    cuit       text NOT NULL UNIQUE,
    settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tenants FROM anon, authenticated;
-- No policies declared on purpose: only the service_role bypasses RLS,
-- so tenants is effectively backend-only.

-- =========================================================================
-- Users (extends auth.users with tenant + role)
-- =========================================================================

CREATE TABLE users (
    id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role       user_role NOT NULL,
    email      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX users_tenant_id_idx ON users (tenant_id);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON users FROM anon;

-- Authenticated users can only see rows of their own tenant.
-- The tenant_id MUST be set in the Supabase Auth user's app_metadata when
-- the row is provisioned (see README §Provisioning).
CREATE POLICY users_select_same_tenant ON users
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid
    );

-- Writes flow exclusively through the backend's service role; clients never
-- INSERT/UPDATE/DELETE this table directly.
