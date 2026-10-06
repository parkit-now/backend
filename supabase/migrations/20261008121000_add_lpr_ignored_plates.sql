CREATE SEQUENCE public.lpr_ignored_plates_sync_seq;
CREATE TABLE public.lpr_ignored_plates (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    plate varchar(20) NOT NULL CHECK (plate ~ '^[A-Z0-9]{1,20}$'),
    notes varchar(500),
    active boolean NOT NULL DEFAULT true,
    valid_from date,
    valid_until date,
    version integer NOT NULL DEFAULT 1,
    sync_seq integer NOT NULL DEFAULT nextval('public.lpr_ignored_plates_sync_seq'),
    deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from <= valid_until)
);
CREATE UNIQUE INDEX lpr_ignored_plates_tenant_plate_uidx
    ON public.lpr_ignored_plates(tenant_id, plate) WHERE deleted_at IS NULL;
CREATE INDEX lpr_ignored_plates_tenant_sync_seq_idx
    ON public.lpr_ignored_plates(tenant_id, sync_seq);

CREATE FUNCTION public.set_lpr_ignored_plates_sync_fields() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    NEW.sync_seq := nextval('public.lpr_ignored_plates_sync_seq');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER lpr_ignored_plates_before_update BEFORE UPDATE ON public.lpr_ignored_plates
    FOR EACH ROW EXECUTE FUNCTION public.set_lpr_ignored_plates_sync_fields();

ALTER TABLE public.lpr_ignored_plates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lpr_ignored_plates FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.lpr_ignored_plates TO authenticated;
GRANT USAGE ON SEQUENCE public.lpr_ignored_plates_sync_seq TO authenticated;
-- Memberships are backend-only. Expose only an access decision for auth.uid(),
-- never a caller-supplied user or membership records.
CREATE FUNCTION public.lpr_ignored_plates_can_access(target_tenant uuid, manage boolean)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_memberships m
        WHERE m.user_id = (SELECT auth.uid()) AND m.tenant_id = target_tenant
          AND (NOT manage OR m.role = 'owner')
    ) OR EXISTS (
        SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'
    );
$$;
REVOKE ALL ON FUNCTION public.lpr_ignored_plates_can_access(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lpr_ignored_plates_can_access(uuid, boolean) TO authenticated;
CREATE POLICY lpr_ignored_plates_read ON public.lpr_ignored_plates
    FOR SELECT TO authenticated USING (
        public.lpr_ignored_plates_can_access(tenant_id, false)
    );
CREATE POLICY lpr_ignored_plates_create ON public.lpr_ignored_plates
    FOR INSERT TO authenticated WITH CHECK (
        public.lpr_ignored_plates_can_access(tenant_id, true)
    );
CREATE POLICY lpr_ignored_plates_update ON public.lpr_ignored_plates
    FOR UPDATE TO authenticated USING (
        public.lpr_ignored_plates_can_access(tenant_id, true)
    ) WITH CHECK (
        public.lpr_ignored_plates_can_access(tenant_id, true)
    );
