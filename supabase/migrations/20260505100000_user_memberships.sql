-- Split user/tenant association out of `users` into a N:M `user_memberships`
-- table.
--
-- Why:
--   * driver / admin users have no tenant.
--   * operator users can belong to several tenants.
--   * owner users have exactly one tenant, but only after they create it
--     (which happens in a separate flow), so they are unlinked at register.
--
-- The "active tenant" still lives in the JWT (`app_metadata.tenant_id`) and
-- drives RLS + `prismaForTenant`. This migration only relocates *where the
-- list of allowed tenants per user* is stored.

-- =========================================================================
-- user_memberships
-- =========================================================================

CREATE TABLE user_memberships (
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, tenant_id)
);

CREATE INDEX user_memberships_tenant_id_idx ON user_memberships (tenant_id);

ALTER TABLE user_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_memberships FROM anon, authenticated;
-- No policies declared on purpose: only the service_role bypasses RLS,
-- so user_memberships is effectively backend-only.

-- =========================================================================
-- users — drop tenant_id column and the tenant-scoped read policy
-- =========================================================================

DROP POLICY IF EXISTS users_select_same_tenant ON users;

DROP INDEX IF EXISTS users_tenant_id_idx;

ALTER TABLE users DROP COLUMN tenant_id;

-- Authenticated users can read their own row regardless of tenant context.
-- Cross-tenant listings of users are backend-only and join through
-- user_memberships.
CREATE POLICY users_select_self ON users
    FOR SELECT
    TO authenticated
    USING (id = (select auth.uid()));
