-- Hard-delete any rows that were previously soft-deleted, then drop the column.
DELETE FROM rates WHERE deleted_at IS NOT NULL;

ALTER TABLE rates DROP COLUMN deleted_at;
