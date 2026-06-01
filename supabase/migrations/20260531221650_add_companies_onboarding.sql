-- Parking-lot onboarding / approval — GLOBAL layer.
--
-- Models the legal entity (Company) that was missing since `cuit` was dropped
-- from `tenants` (see 20260505200000_drop_tenants_cuit.sql). A tenant is still a
-- single parking lot / branch; it now hangs off a parent Company.
--
-- Flow:
--   1. The owner (role=owner) creates a Company (status=pending) plus an
--      OnboardingApplication (status=draft) and declares branches/documents.
--   2. Submit -> the application moves to pending_review.
--   3. PARKIT Ops (role=admin) approves (company->active, the declared tenants
--      are created together with the owner's memberships and payment methods)
--      or rejects (with a reason, allowing resubmission).
--
-- Every table in this file is backend-only (service-role): RLS enabled with no
-- policies, just like `tenants` / `password_reset_requests`.

-- =========================================================================
-- Enums
-- =========================================================================

CREATE TYPE company_status AS ENUM (
    'pending',    -- created, awaiting approval
    'active',     -- approved, full access
    'suspended'   -- suspended by Ops
);

CREATE TYPE branch_status AS ENUM (
    'active',
    'maintenance'
);

CREATE TYPE application_status AS ENUM (
    'draft',          -- being edited by the owner
    'pending_review', -- submitted, awaiting Ops review
    'approved',
    'rejected'
);

CREATE TYPE payment_method_type AS ENUM (
    'mp_transfer', -- bank transfer (Mercado Pago)
    'cash',
    'other'
);

CREATE TYPE audit_severity AS ENUM (
    'info',
    'warn',
    'crit'
);

-- =========================================================================
-- companies (legal entity) — backend-only
-- =========================================================================

CREATE TABLE companies (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_name    text NOT NULL,
    cuit          text NOT NULL UNIQUE,
    email         varchar(255) NOT NULL,
    phone         text,
    address       text,
    status        company_status NOT NULL DEFAULT 'pending',
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX companies_owner_user_id_idx ON companies (owner_user_id);

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON companies FROM anon, authenticated;
-- Backend-only: only the service-role has access (same pattern as `tenants`).

-- =========================================================================
-- tenants: link each lot/branch to its Company + status/address
-- =========================================================================
-- `company_id` stays NULLABLE so legacy/demo tenants and the `make reset` smoke
-- keep working (existing seed tenants have no company).
--
-- `nombre` was the only Spanish column left on `tenants`; rename it to `name`
-- so the whole API speaks English (the front renders Spanish labels itself).

ALTER TABLE tenants RENAME COLUMN nombre TO name;
ALTER TABLE tenants ADD COLUMN company_id uuid REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE tenants ADD COLUMN address text;
ALTER TABLE tenants ADD COLUMN status branch_status NOT NULL DEFAULT 'active';

CREATE INDEX tenants_company_id_idx ON tenants (company_id);

-- =========================================================================
-- onboarding_applications (onboarding request) — backend-only
-- =========================================================================
-- A company can have several applications over time (rejection -> resubmit).
-- `declared_branches` holds the branches declared before approval:
-- [{ name, address, carSpots, motorcycleSpots, bicycleSpots }]. On approval
-- they are materialized as rows in `tenants`.

CREATE TABLE onboarding_applications (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    status            application_status NOT NULL DEFAULT 'draft',
    declared_branches jsonb NOT NULL DEFAULT '[]'::jsonb,
    submitted_at      timestamptz,
    reviewed_at       timestamptz,
    reviewed_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    rejection_reason  text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX onboarding_applications_company_id_idx ON onboarding_applications (company_id);
CREATE INDEX onboarding_applications_status_idx ON onboarding_applications (status);

ALTER TABLE onboarding_applications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON onboarding_applications FROM anon, authenticated;

-- =========================================================================
-- company_documents (documentation) — backend-only
-- =========================================================================
-- Metadata only; the binary is uploaded to Supabase Storage from the client and
-- only its `storage_path` is kept here. Feeds the front `docsCount` counter.

CREATE TABLE company_documents (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    application_id uuid REFERENCES onboarding_applications(id) ON DELETE SET NULL,
    name           text NOT NULL,
    storage_path   text NOT NULL,
    mime_type      text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX company_documents_company_id_idx ON company_documents (company_id);
CREATE INDEX company_documents_application_id_idx ON company_documents (application_id);

ALTER TABLE company_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON company_documents FROM anon, authenticated;

-- =========================================================================
-- payment_methods (company-level payment methods) — backend-only
-- =========================================================================
-- On company approval, 'mp_transfer' and 'cash' are created automatically
-- (enabled, is_system=true -> not deletable but can be disabled).
-- UNIQUE(company_id, type) prevents duplicating a system method per company.

CREATE TABLE payment_methods (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    type       payment_method_type NOT NULL,
    name       text NOT NULL,
    enabled    boolean NOT NULL DEFAULT true,
    is_system  boolean NOT NULL DEFAULT false,
    is_default boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, type)
);

CREATE INDEX payment_methods_company_id_idx ON payment_methods (company_id);

ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON payment_methods FROM anon, authenticated;

-- =========================================================================
-- audit_log (generic audit trail) — backend-only
-- =========================================================================
-- Records onboarding-flow events: application create/edit/submit, approval,
-- rejection, suspension and configuration changes. The subset exposed to the
-- front maps to the `AuditEvent` type.

CREATE TABLE audit_log (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    company_id    uuid REFERENCES companies(id) ON DELETE SET NULL,
    action        text NOT NULL,
    entity_type   text NOT NULL,
    entity_id     uuid,
    severity      audit_severity NOT NULL DEFAULT 'info',
    metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_company_id_created_at_idx ON audit_log (company_id, created_at);
CREATE INDEX audit_log_action_idx ON audit_log (action);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON audit_log FROM anon, authenticated;
