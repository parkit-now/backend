-- LPR detection events: auditable local-camera detections synced from desktop.
--
-- Captures the operator-facing lifecycle of an OCR/camera event independently
-- from the final parking entry. Photos are intentionally deferred for a future
-- Supabase Storage bucket; image fields stay nullable in this migration.

CREATE TYPE lpr_detection_status AS ENUM (
    'pending',
    'registered',
    'dismissed',
    'suppressed_active_entry',
    'suppressed_pending_event',
    'suppressed_recent_exit'
);

CREATE TYPE lpr_format_type AS ENUM (
    'argentina_old',
    'argentina_mercosur',
    'unknown'
);

CREATE TYPE lpr_quality_status AS ENUM (
    'valid_high',
    'valid_low',
    'invalid_format',
    'low_confidence'
);

CREATE SEQUENCE lpr_detection_events_sync_seq;

CREATE TABLE lpr_detection_events (
    id                  uuid PRIMARY KEY,
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    camera_id           varchar(100) NOT NULL,
    location            varchar(50) NOT NULL,
    first_seen_at       timestamptz NOT NULL,
    last_seen_at        timestamptz NOT NULL,
    raw_text            varchar(32),
    normalized_text     varchar(20),
    display_plate       varchar(32),
    confidence          real NOT NULL DEFAULT 0,
    format_valid        boolean NOT NULL DEFAULT false,
    format_type         lpr_format_type NOT NULL DEFAULT 'unknown',
    quality_status      lpr_quality_status NOT NULL DEFAULT 'low_confidence',
    status              lpr_detection_status NOT NULL DEFAULT 'pending',
    entry_id            uuid REFERENCES entries(id) ON DELETE SET NULL,
    reviewed_at         timestamptz,
    reviewed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    image_storage_path  text,
    image_url           text,
    best_capture_id     text,
    candidates          jsonb NOT NULL DEFAULT '[]'::jsonb,
    version             integer NOT NULL DEFAULT 1,
    sync_seq            integer NOT NULL DEFAULT nextval('lpr_detection_events_sync_seq'),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX lpr_detection_events_tenant_id_idx
    ON lpr_detection_events (tenant_id);
CREATE INDEX lpr_detection_events_tenant_sync_seq_idx
    ON lpr_detection_events (tenant_id, sync_seq);
CREATE INDEX lpr_detection_events_tenant_updated_at_idx
    ON lpr_detection_events (tenant_id, updated_at);
CREATE INDEX lpr_detection_events_tenant_status_idx
    ON lpr_detection_events (tenant_id, status);
CREATE INDEX lpr_detection_events_tenant_plate_idx
    ON lpr_detection_events (tenant_id, normalized_text)
    WHERE normalized_text IS NOT NULL;
CREATE INDEX lpr_detection_events_entry_id_idx
    ON lpr_detection_events (entry_id)
    WHERE entry_id IS NOT NULL;

CREATE OR REPLACE FUNCTION set_lpr_detection_events_sync_fields()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    NEW.sync_seq   := nextval('lpr_detection_events_sync_seq');
    IF TG_OP = 'UPDATE' THEN
        NEW.version := OLD.version + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lpr_detection_events_before_update
BEFORE UPDATE ON lpr_detection_events
FOR EACH ROW
EXECUTE FUNCTION set_lpr_detection_events_sync_fields();

ALTER TABLE lpr_detection_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON lpr_detection_events FROM anon;

CREATE POLICY lpr_detection_events_select_same_tenant ON lpr_detection_events
    FOR SELECT TO authenticated
    USING (tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid);

CREATE POLICY lpr_detection_events_insert_same_tenant ON lpr_detection_events
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid);

CREATE POLICY lpr_detection_events_update_same_tenant ON lpr_detection_events
    FOR UPDATE TO authenticated
    USING  (tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid)
    WITH CHECK (tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid);

CREATE POLICY lpr_detection_events_delete_same_tenant ON lpr_detection_events
    FOR DELETE TO authenticated
    USING (tenant_id = (((select auth.jwt()) -> 'app_metadata') ->> 'tenant_id')::uuid);
