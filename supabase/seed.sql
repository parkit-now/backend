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
-- This file seeds global data (`tenants` + global catalog examples).
-- Auth users/memberships are created by `scripts/seed-auth.ts` and tenant-local
-- business rows are created by `scripts/seed-tenant.ts`.

-- Keep this file as a single SQL statement because `supabase db query --file`
-- may execute it via a prepared statement that rejects multiple commands.
DO $seed$
BEGIN
    IF to_regclass('public.tenants') IS NOT NULL THEN
        INSERT INTO tenants (id, name) VALUES
            ('11111111-1111-4111-8111-111111111111', 'Estacionamiento Once'),
            ('22222222-2222-4222-8222-222222222222', 'Estacionamiento Belgrano')
        ON CONFLICT (id) DO NOTHING;
    END IF;

END
$seed$;
