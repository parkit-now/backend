ALTER TABLE lpr_detection_events
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS lpr_detection_events_tenant_status_archived_idx
  ON lpr_detection_events(tenant_id, status, archived_at);

