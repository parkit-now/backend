-- Auto-provision a `public.users` row whenever Supabase Auth creates
-- a new identity in `auth.users` (email/password or social OAuth).
--
-- Goal:
--   - Keep backend guards stable (`JwtAuthGuard` expects a row in public.users).
--   - Avoid adding provider-specific logic in NestJS.
--   - Default least-privilege role for self-signup identities: `driver`.

CREATE OR REPLACE FUNCTION public.provision_public_user_from_auth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Defensive guard: skip identities without email.
    IF NEW.email IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.users (id, role, email)
    VALUES (NEW.id, 'driver'::user_role, NEW.email)
    ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email
    WHERE public.users.email IS DISTINCT FROM EXCLUDED.email;

    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_provision_public_user ON auth.users;

CREATE TRIGGER on_auth_user_created_provision_public_user
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.provision_public_user_from_auth();
