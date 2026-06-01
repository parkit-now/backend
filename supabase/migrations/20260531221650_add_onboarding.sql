-- Parking-lot onboarding / approval — GLOBAL layer.
--
-- There is no company grouping: users are attached directly to entities
-- (tenants) via `user_memberships`, and an onboarding application is a request
-- to register ONE entity. Legal/contact data (legal_name, cuit, email, phone)
-- lives on `tenants`.
--
-- Flow:
--   1. A user creates an OnboardingApplication (status=draft) declaring a single
--      entity in `declared_entity` (name, address, legal data, spots) and
--      attaches documents.
--   2. Submit -> the application moves to pending_review.
--   3. PARKIT Ops (role=admin) approves -> the entity is materialized as a row
--      in `tenants`, together with the applicant's owner membership, an initial
--      zone and the default payment methods; the applicant is promoted to owner
--      if needed. Reject stores a reason and allows resubmission.
--
-- Every table in this file is backend-only (service-role): RLS enabled with no
-- policies, just like `tenants` / `password_reset_requests`.

-- =========================================================================
-- Enums
-- =========================================================================

CREATE TYPE branch_status AS ENUM (
    'active',
    'maintenance'
);

CREATE TYPE application_status AS ENUM (
    'draft',          -- being edited by the applicant
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
-- tenants: the entity itself now carries legal/contact data + status
-- =========================================================================
-- `nombre` was the only Spanish column left on `tenants`; rename it to `name`
-- so the whole API speaks English (the front renders Spanish labels itself).
-- `cuit` is NOT unique: several lots may belong to the same legal entity.

ALTER TABLE tenants RENAME COLUMN nombre TO name;
ALTER TABLE tenants ADD COLUMN legal_name text;
ALTER TABLE tenants ADD COLUMN cuit text;
ALTER TABLE tenants ADD COLUMN email varchar(255);
ALTER TABLE tenants ADD COLUMN phone text;
ALTER TABLE tenants ADD COLUMN address text;
ALTER TABLE tenants ADD COLUMN status branch_status NOT NULL DEFAULT 'active';

CREATE INDEX tenants_cuit_idx ON tenants (cuit);

-- =========================================================================
-- onboarding_applications (request to register one entity) — backend-only
-- =========================================================================
-- A user can have several applications over time (one per lot, or
-- rejection -> resubmit). `declared_entity` holds the entity declared before
-- approval: { name, address, legalName, cuit, email, phone, carSpots,
-- motorcycleSpots, bicycleSpots }. On approval it is materialized as a row in
-- `tenants` and linked back via `tenant_id`.

CREATE TABLE onboarding_applications (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    applicant_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id         uuid REFERENCES tenants(id) ON DELETE SET NULL,
    status            application_status NOT NULL DEFAULT 'draft',
    declared_entity   jsonb NOT NULL DEFAULT '{}'::jsonb,
    submitted_at      timestamptz,
    reviewed_at       timestamptz,
    reviewed_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    rejection_reason  text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX onboarding_applications_applicant_user_id_idx ON onboarding_applications (applicant_user_id);
CREATE INDEX onboarding_applications_status_idx ON onboarding_applications (status);

ALTER TABLE onboarding_applications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON onboarding_applications FROM anon, authenticated;

-- =========================================================================
-- application_documents (documentation) — backend-only
-- =========================================================================
-- Metadata only; the binary is uploaded to Supabase Storage from the client and
-- only its `storage_path` is kept here. Feeds the front `docsCount` counter.

CREATE TABLE application_documents (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id uuid NOT NULL REFERENCES onboarding_applications(id) ON DELETE CASCADE,
    name           text NOT NULL,
    storage_path   text NOT NULL,
    mime_type      text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX application_documents_application_id_idx ON application_documents (application_id);

ALTER TABLE application_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON application_documents FROM anon, authenticated;

-- =========================================================================
-- payment_methods (entity-level payment methods) — backend-only
-- =========================================================================
-- On entity approval, 'mp_transfer' and 'cash' are created automatically
-- (enabled, is_system=true -> not deletable but can be disabled).
-- UNIQUE(tenant_id, type) prevents duplicating a system method per entity.

CREATE TABLE payment_methods (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    type       payment_method_type NOT NULL,
    name       text NOT NULL,
    enabled    boolean NOT NULL DEFAULT true,
    is_system  boolean NOT NULL DEFAULT false,
    is_default boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, type)
);

CREATE INDEX payment_methods_tenant_id_idx ON payment_methods (tenant_id);

ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON payment_methods FROM anon, authenticated;

-- =========================================================================
-- audit_log (generic audit trail) — backend-only
-- =========================================================================
-- Records onboarding-flow events: application create/edit/submit, approval,
-- rejection, suspension and configuration changes. `tenant_id` is nullable
-- because some events (e.g. an application still in draft) have no entity yet.

CREATE TABLE audit_log (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    tenant_id     uuid REFERENCES tenants(id) ON DELETE SET NULL,
    action        text NOT NULL,
    entity_type   text NOT NULL,
    entity_id     uuid,
    severity      audit_severity NOT NULL DEFAULT 'info',
    metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_tenant_id_created_at_idx ON audit_log (tenant_id, created_at);
CREATE INDEX audit_log_action_idx ON audit_log (action);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON audit_log FROM anon, authenticated;
