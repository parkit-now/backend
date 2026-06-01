-- Custom access token hook: inject the app role into the JWT.
--
-- Supabase mints JWTs without our app role (`public.users.role`). Email/password
-- register/seed write it into `app_metadata`, but OAuth identities (Google,
-- GitHub) are auto-provisioned by a DB trigger and never get the claim, so their
-- tokens carry no role and the client cannot route them.
--
-- This hook runs on every token mint (email/password AND OAuth) and copies the
-- current role from `public.users` into `claims.app_metadata.role`. It is the
-- single, always-fresh source of the role claim: a role change (e.g. a driver
-- promoted to owner) is reflected on the next token without any extra wiring.
--
-- SECURITY DEFINER so it can read `public.users` regardless of RLS; the function
-- is only EXECUTE-able by `supabase_auth_admin` (the role the Auth server uses).
-- Enabled in `supabase/config.toml` under [auth.hook.custom_access_token].

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

-- Only the Auth server may run the hook.
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb)
  FROM authenticated, anon, public;
