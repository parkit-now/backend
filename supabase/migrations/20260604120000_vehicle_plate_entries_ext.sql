-- Add plate to vehicles (nullable; existing records may not have it).
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS plate VARCHAR(20);

-- Allow full-length plate strings on entries (was VARCHAR(10)).
ALTER TABLE entries
  ALTER COLUMN plate TYPE VARCHAR(20);

-- Optional operational notes on entries.
ALTER TABLE entries
  ADD COLUMN IF NOT EXISTS cochera VARCHAR(100),
  ADD COLUMN IF NOT EXISTS notes   TEXT;
