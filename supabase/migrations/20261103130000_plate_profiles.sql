-- Supabase executes migrations transactionally. Keep confirmations from
-- slipping between the historical snapshot and installing the entry trigger.
LOCK TABLE public.entries IN SHARE ROW EXCLUSIVE MODE;

CREATE SEQUENCE public.plate_profiles_sync_seq;
CREATE TABLE public.plate_profiles (
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    plate varchar(20) NOT NULL CHECK (plate ~ '^[A-Z0-9]{1,20}$'),
    vehicle_brand varchar(120), vehicle_model varchar(120),
    vehicle_type_id uuid, vehicle_type_name varchar(120), color varchar(50),
    rate_id uuid, rate_name varchar(120),
    last_entry_id uuid, last_entered_at timestamptz, learn_after timestamptz,
    edit_version integer NOT NULL DEFAULT 0,
    version integer NOT NULL DEFAULT 1,
    sync_seq integer NOT NULL DEFAULT nextval('public.plate_profiles_sync_seq'),
    deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, plate)
);
CREATE INDEX plate_profiles_tenant_sync_seq_idx ON public.plate_profiles(tenant_id, sync_seq);
-- References are deliberately snapshots, not foreign keys: deleting a catalog
-- option must not erase the owner's ability to inspect its previous association.
CREATE TABLE public.plate_profile_mutations (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    plate varchar(20) NOT NULL
);
CREATE FUNCTION public.set_plate_profiles_sync_fields() RETURNS trigger AS $$
BEGIN
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
    NEW.sync_seq := nextval('public.plate_profiles_sync_seq');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER plate_profiles_before_update BEFORE UPDATE ON public.plate_profiles
    FOR EACH ROW EXECUTE FUNCTION public.set_plate_profiles_sync_fields();

-- One-time, complete-history backfill. Brand/model are chosen from the same
-- visit; independent optional fields retain their last known nonempty value.
WITH history AS (
    SELECT e.*, upper(regexp_replace(e.plate, '[^a-zA-Z0-9]', '', 'g')) AS normalized
    FROM public.entries e WHERE e.deleted_at IS NULL
), grouped AS (
    SELECT tenant_id, normalized,
        (array_agg(id ORDER BY entered_at DESC, id DESC))[1] AS last_entry_id,
        max(entered_at) AS last_entered_at,
        (array_agg(jsonb_build_array(vehicle_brand, vehicle_model) ORDER BY entered_at DESC, id DESC)
            FILTER (WHERE nullif(trim(vehicle_brand), '') IS NOT NULL OR nullif(trim(vehicle_model), '') IS NOT NULL))[1] AS vehicle,
        (array_agg(vehicle_type_id ORDER BY entered_at DESC, id DESC) FILTER (WHERE vehicle_type_id IS NOT NULL))[1] AS type_id,
        (array_agg(color ORDER BY entered_at DESC, id DESC) FILTER (WHERE nullif(trim(color), '') IS NOT NULL))[1] AS color,
        (array_agg(rate_id ORDER BY entered_at DESC, id DESC) FILTER (WHERE rate_id IS NOT NULL))[1] AS rate_id,
        (array_agg(rate_snapshot_name ORDER BY entered_at DESC, id DESC) FILTER (WHERE rate_id IS NOT NULL))[1] AS rate_name
    FROM history WHERE normalized ~ '^[A-Z0-9]{1,20}$' GROUP BY tenant_id, normalized
)
INSERT INTO public.plate_profiles (tenant_id, plate, vehicle_brand, vehicle_model,
    vehicle_type_id, vehicle_type_name, color, rate_id, rate_name, last_entry_id, last_entered_at)
SELECT g.tenant_id, normalized, vehicle->>0, vehicle->>1, type_id, t.name,
    g.color, g.rate_id, g.rate_name, last_entry_id, last_entered_at
FROM grouped g LEFT JOIN public.vehicle_types t ON t.id = g.type_id AND t.tenant_id = g.tenant_id;

CREATE FUNCTION public.learn_plate_profile_from_entry() RETURNS trigger AS $$
DECLARE
    normalized text := upper(regexp_replace(NEW.plate, '[^a-zA-Z0-9]', '', 'g'));
    current_profile public.plate_profiles%ROWTYPE;
    type_name text;
    brand_changed boolean := true;
    type_changed boolean := true;
    color_changed boolean := true;
    rate_changed boolean := true;
BEGIN
    IF NEW.deleted_at IS NOT NULL OR normalized !~ '^[A-Z0-9]{1,20}$' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' THEN
        brand_changed := ROW(NEW.vehicle_brand, NEW.vehicle_model) IS DISTINCT FROM ROW(OLD.vehicle_brand, OLD.vehicle_model);
        type_changed := NEW.vehicle_type_id IS DISTINCT FROM OLD.vehicle_type_id;
        color_changed := NEW.color IS DISTINCT FROM OLD.color;
        rate_changed := NEW.rate_id IS DISTINCT FROM OLD.rate_id;
        IF NOT (brand_changed OR type_changed OR color_changed OR rate_changed OR NEW.plate IS DISTINCT FROM OLD.plate) THEN RETURN NEW; END IF;
        IF NEW.plate IS DISTINCT FROM OLD.plate THEN
            brand_changed := true; type_changed := true; color_changed := true; rate_changed := true;
        END IF;
        IF EXISTS (
            SELECT 1 FROM public.entries e WHERE e.tenant_id = NEW.tenant_id AND e.deleted_at IS NULL
              AND upper(regexp_replace(e.plate, '[^a-zA-Z0-9]', '', 'g')) = normalized
              AND ROW(e.entered_at, e.id) > ROW(NEW.entered_at, NEW.id)
        ) THEN RETURN NEW; END IF;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || ':' || normalized, 0));
    SELECT * INTO current_profile FROM public.plate_profiles
        WHERE tenant_id = NEW.tenant_id AND plate = normalized FOR UPDATE;
    -- Updates never recreate forgotten profiles; neither do delayed old entries.
    IF current_profile.deleted_at IS NOT NULL AND
       (TG_OP <> 'INSERT' OR NEW.entered_at <= coalesce(current_profile.learn_after, current_profile.deleted_at)) THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' AND current_profile.last_entered_at IS NOT NULL AND
       ROW(NEW.entered_at, NEW.id) < ROW(current_profile.last_entered_at, current_profile.last_entry_id) THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' AND NEW.entered_at <= current_profile.learn_after THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND current_profile.plate IS NULL AND NEW.plate = OLD.plate THEN RETURN NEW; END IF;
    SELECT name INTO type_name FROM public.vehicle_types
        WHERE id = NEW.vehicle_type_id AND tenant_id = NEW.tenant_id;
    INSERT INTO public.plate_profiles AS p (tenant_id, plate, vehicle_brand, vehicle_model,
        vehicle_type_id, vehicle_type_name, color, rate_id, rate_name, last_entry_id, last_entered_at)
    VALUES (NEW.tenant_id, normalized, NEW.vehicle_brand, NEW.vehicle_model,
        NEW.vehicle_type_id, type_name, NEW.color, NEW.rate_id, NEW.rate_snapshot_name, NEW.id, NEW.entered_at)
    ON CONFLICT (tenant_id, plate) DO UPDATE SET
        vehicle_brand = CASE WHEN brand_changed THEN EXCLUDED.vehicle_brand ELSE p.vehicle_brand END,
        vehicle_model = CASE WHEN brand_changed THEN EXCLUDED.vehicle_model ELSE p.vehicle_model END,
        vehicle_type_id = CASE WHEN type_changed THEN EXCLUDED.vehicle_type_id ELSE p.vehicle_type_id END,
        vehicle_type_name = CASE WHEN type_changed THEN EXCLUDED.vehicle_type_name ELSE p.vehicle_type_name END,
        color = CASE WHEN color_changed THEN EXCLUDED.color ELSE p.color END,
        rate_id = CASE WHEN rate_changed THEN EXCLUDED.rate_id ELSE p.rate_id END,
        rate_name = CASE WHEN rate_changed THEN EXCLUDED.rate_name ELSE p.rate_name END,
        last_entry_id = EXCLUDED.last_entry_id, last_entered_at = EXCLUDED.last_entered_at,
        deleted_at = NULL;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';
CREATE TRIGGER entries_learn_plate_profile AFTER INSERT OR UPDATE ON public.entries
    FOR EACH ROW EXECUTE FUNCTION public.learn_plate_profile_from_entry();
REVOKE ALL ON FUNCTION public.learn_plate_profile_from_entry() FROM PUBLIC, anon, authenticated;
ALTER TABLE public.plate_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plate_profile_mutations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.plate_profiles, public.plate_profile_mutations FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.plate_profiles TO authenticated;
GRANT USAGE ON SEQUENCE public.plate_profiles_sync_seq TO authenticated;
CREATE POLICY plate_profiles_read ON public.plate_profiles FOR SELECT TO authenticated
    USING (public.lpr_ignored_plates_can_access(tenant_id, false));
CREATE POLICY plate_profiles_insert ON public.plate_profiles FOR INSERT TO authenticated
    WITH CHECK (public.clients_can_manage(tenant_id));
CREATE POLICY plate_profiles_update ON public.plate_profiles FOR UPDATE TO authenticated
    USING (public.clients_can_manage(tenant_id)) WITH CHECK (public.clients_can_manage(tenant_id));
