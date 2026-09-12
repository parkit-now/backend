-- Payment transaction tombstones for offline-safe payment corrections.
-- Edited payment breakdowns mark old rows as deleted instead of removing them,
-- so incremental sync can tell every desktop to drop stale local rows.

ALTER TABLE payment_transactions
    ADD COLUMN deleted_at timestamptz;
