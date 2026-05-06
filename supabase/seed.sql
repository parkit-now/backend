-- Local-only seed data.
-- Applied automatically by `supabase db reset` (i.e. `make reset` and
-- `make migrate`). NEVER applied by `supabase db push --linked` to cloud,
-- so this file is safe to keep checked in.
--
-- IDs are stable UUIDs so the seed is reproducible across resets — handy
-- when wiring tests or hardcoding tenant IDs in fixtures.
--
-- A tenant is a parking lot, and an owner can run several. We seed two lots
-- so the dev fixtures actually exercise the multi-lot case.
--
-- This file only seeds `tenants`. Auth users (and their `public.users`
-- rows) are created by `scripts/seed.ts` because they require Supabase
-- Auth admin calls — run `make seed` after `make reset`.

INSERT INTO tenants (id, nombre) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Estacionamiento Once'),
    ('22222222-2222-2222-2222-222222222222', 'Estacionamiento Belgrano')
ON CONFLICT (id) DO NOTHING;
