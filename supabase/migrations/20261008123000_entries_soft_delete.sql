-- Keep deleted stays in the sync feed and audit trail without counting them in operations.
ALTER TABLE entries ADD COLUMN deleted_at timestamptz;
CREATE INDEX entries_tenant_live_session_idx
  ON entries (tenant_id, cash_session_id) WHERE deleted_at IS NULL;
