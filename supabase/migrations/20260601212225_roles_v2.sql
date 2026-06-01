-- Roles v2: scoped roles.
--
-- The GLOBAL role collapses from {admin, owner, operator, driver} to
-- {admin, user}. The per-entity role (owner|operator) moves to
-- `user_memberships.role`. A `user` with no membership is just an end user
-- (e.g. a mobile driver); `admin` keeps god-mode (bypasses membership checks).
--
-- Order matters: backfill the membership role from the OLD global role BEFORE
-- collapsing the enum, and recreate the functions that declare `public.user_role`
-- before dropping the old type (otherwise DROP TYPE fails on dependency).

-- 1) Per-entity role on user_memberships ------------------------------------
CREATE TYPE membership_role AS ENUM ('owner', 'operator');

ALTER TABLE user_memberships
    ADD COLUMN role membership_role NOT NULL DEFAULT 'operator';

-- Backfill: members whose (old) global role was 'owner' become owner; everyone
-- else keeps the 'operator' default.
UPDATE user_memberships m
SET role = 'owner'
FROM users u
WHERE u.id = m.user_id AND u.role::text = 'owner';

ALTER TABLE user_memberships ALTER COLUMN role DROP DEFAULT;

-- 2) Collapse the global user_role enum to {admin, user} ---------------------
ALTER TYPE user_role RENAME TO user_role_old;
CREATE TYPE user_role AS ENUM ('admin', 'user');

ALTER TABLE users
    ALTER COLUMN role TYPE user_role
    USING (CASE WHEN role::text = 'admin' THEN 'admin' ELSE 'user' END)::user_role;

-- 3) Recreate the functions that declare public.user_role (re-bind to the new
--    type; provisioning now defaults to 'user' instead of 'driver').
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claims jsonb := event -> 'claims';
  v_role public.user_role;
BEGIN
  SELECT role INTO v_role FROM public.users WHERE id = (event ->> 'user_id')::uuid;

  IF v_role IS NOT NULL THEN
    IF jsonb_typeof(claims -> 'app_metadata') = 'object' THEN
      claims := jsonb_set(claims, '{app_metadata,role}', to_jsonb(v_role::text));
    ELSE
      claims := jsonb_set(
        claims,
        '{app_metadata}',
        jsonb_build_object('role', v_role::text)
      );
    END IF;
    event := jsonb_set(event, '{claims}', claims);
  END IF;

  RETURN event;
END;
$$;

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb)
  FROM authenticated, anon, public;

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
    VALUES (NEW.id, 'user'::user_role, NEW.email)
    ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email
    WHERE public.users.email IS DISTINCT FROM EXCLUDED.email;

    RETURN NEW;
END
$$;

-- 4) Drop the old enum (no dependencies remain).
DROP TYPE user_role_old;
