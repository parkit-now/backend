-- Align users.email with the Prisma schema:
--   * narrow type from text to varchar(255)
--   * enforce uniqueness (already declared @unique in prisma/schema/auth.prisma)
-- The column was created in the init migration as `email text NOT NULL`,
-- which drifted from the Prisma model. This migration brings the DB in line.

ALTER TABLE users
    ALTER COLUMN email TYPE varchar(255);

ALTER TABLE users
    ADD CONSTRAINT users_email_unique UNIQUE (email);
