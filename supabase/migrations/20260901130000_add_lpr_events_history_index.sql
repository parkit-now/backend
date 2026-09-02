-- Event-history search (SCRUM-138): owner-facing audit view over past LPR
-- detections, filtered by detection timestamp and ordered newest-first.
--
-- The existing indexes cover (tenant_id, sync_seq / updated_at / status) and
-- the partial (tenant_id, normalized_text) plate lookup. None of them serve an
-- `ORDER BY last_seen_at DESC` + range scan, which is the hot path for the
-- history list, so add a dedicated composite. A plain btree on
-- (tenant_id, last_seen_at) supports both the range predicate and the
-- descending sort via a backward index scan.

CREATE INDEX IF NOT EXISTS lpr_detection_events_tenant_last_seen_at_idx
    ON lpr_detection_events (tenant_id, last_seen_at);
