-- Allow desktop client to provide vehicle UUID (offline-first support).
-- Matches the pattern already used by rates and entries.
ALTER TABLE vehicles ALTER COLUMN id DROP DEFAULT;
