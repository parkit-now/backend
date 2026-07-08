ALTER TABLE lpr_detection_events
  ADD COLUMN IF NOT EXISTS image_deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS lpr_detection_events_image_purge_idx
  ON lpr_detection_events (status, image_storage_path)
  WHERE image_storage_path IS NOT NULL AND image_deleted_at IS NULL;
