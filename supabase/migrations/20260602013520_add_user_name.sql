-- Add a display `name` to public.users, sourced from Supabase Auth metadata.
--
-- The user's name is not part of the auth credentials: it lives in
-- `auth.users.raw_user_meta_data` (e.g. `full_name`/`name` from OAuth providers
-- or the sign-up payload). Mirror it into `public.users.name` so the admin panel
-- can search/display users by name without reaching into the auth schema.
--
-- Nullable on purpose: email/password sign-ups may not carry a name.

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS name text;

-- Backfill existing rows from the auth metadata.
UPDATE public.users u
SET name = coalesce(
    a.raw_user_meta_data ->> 'full_name',
    a.raw_user_meta_data ->> 'name'
)
FROM auth.users a
WHERE a.id = u.id
  AND u.name IS NULL;

-- Keep the provisioning trigger in sync: capture the name on insert and refresh
-- it when the auth metadata changes. Re-declares the function defined in
-- 20260601212225_roles_v2.sql, preserving the `user` global-role default.
CREATE OR REPLACE FUNCTION public.provision_public_user_from_auth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name text := coalesce(
        NEW.raw_user_meta_data ->> 'full_name',
        NEW.raw_user_meta_data ->> 'name'
    );
BEGIN
    -- Defensive guard: skip identities without email.
    IF NEW.email IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.users (id, role, email, name)
    VALUES (NEW.id, 'user'::user_role, NEW.email, v_name)
    ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        name  = coalesce(EXCLUDED.name, public.users.name)
    WHERE public.users.email IS DISTINCT FROM EXCLUDED.email
       OR public.users.name  IS DISTINCT FROM EXCLUDED.name;

    RETURN NEW;
END
$$;
