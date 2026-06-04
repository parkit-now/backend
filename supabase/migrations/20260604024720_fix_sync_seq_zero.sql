-- Fix records created with sync_seq=0.
--
-- Root cause: Prisma schema had @default(0) on syncSeq, which caused Prisma to
-- send sync_seq=0 explicitly in INSERT statements, overriding the PostgreSQL
-- DEFAULT nextval(...). Records with sync_seq=0 are invisible to the desktop
-- pullChanges endpoint (which queries syncSeq > lastSeq, starting at 0).
--
-- This migration assigns a real sequence value to every zero-seq row so they
-- become visible to the incremental sync protocol.

UPDATE rates   SET sync_seq = nextval('rates_sync_seq')    WHERE sync_seq = 0;
UPDATE entries SET sync_seq = nextval('entries_sync_seq')  WHERE sync_seq = 0;
