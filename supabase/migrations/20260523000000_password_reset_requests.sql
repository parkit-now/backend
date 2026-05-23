-- Password recovery audit trail.
--
-- Stores one row per attempt to reset a password. The recovery TOKEN itself
-- is generated and validated by Supabase Auth (`generateLink` / `verifyOtp`),
-- not by us, so we never store it here — Supabase already enforces TTL +
-- single-use. This table only enables rate-limiting and post-hoc visibility.
--
-- Backend-only: service-role writes; no policies declared so anon /
-- authenticated cannot read or write through PostgREST.

-- =========================================================================
-- password_reset_request_status enum
-- =========================================================================

CREATE TYPE password_reset_request_status AS ENUM (
    'sent',
    'email_failed',
    'ignored_unknown_email',
    'ignored_rate_limited',
    'completed'
);

-- =========================================================================
-- password_reset_requests
-- =========================================================================

CREATE TABLE password_reset_requests (
    id            uuid                          NOT NULL DEFAULT gen_random_uuid(),
    email         varchar(255)                  NOT NULL,
    ip_address    varchar(64),
    status        password_reset_request_status NOT NULL,
    requested_at  timestamptz                   NOT NULL DEFAULT now(),
    completed_at  timestamptz,
    PRIMARY KEY (id)
);

CREATE INDEX password_reset_requests_email_requested_at_idx
    ON password_reset_requests (email, requested_at);

ALTER TABLE password_reset_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON password_reset_requests FROM anon, authenticated;
-- No policies on purpose: only the service-role connection touches this
-- table, mirroring the pattern used for `tenants` and `user_memberships`.
