CREATE SEQUENCE public.clients_sync_seq;

CREATE TABLE public.clients (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    cuit varchar(11) CHECK (cuit IS NULL OR cuit ~ '^[0-9]{11}$'),
    name varchar(200),
    name_edited boolean NOT NULL DEFAULT false,
    email varchar(254),
    phone varchar(40),
    version integer NOT NULL DEFAULT 1,
    sync_seq integer NOT NULL DEFAULT nextval('public.clients_sync_seq'),
    deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX clients_tenant_cuit_uidx ON public.clients(tenant_id, cuit)
    WHERE deleted_at IS NULL AND cuit IS NOT NULL;
ALTER TABLE public.clients ADD CONSTRAINT clients_tenant_id_uidx UNIQUE (tenant_id, id);
CREATE INDEX clients_tenant_sync_seq_idx ON public.clients(tenant_id, sync_seq);

CREATE TABLE public.client_plates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    client_id uuid NOT NULL,
    plate varchar(20) NOT NULL CHECK (plate ~ '^[A-Z0-9]{1,20}$'),
    deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, client_id) REFERENCES public.clients(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX client_plates_tenant_plate_uidx ON public.client_plates(tenant_id, plate)
    WHERE deleted_at IS NULL;
CREATE INDEX client_plates_tenant_client_idx ON public.client_plates(tenant_id, client_id);

CREATE FUNCTION public.set_clients_sync_fields() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    NEW.sync_seq := nextval('public.clients_sync_seq');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER clients_before_update BEFORE UPDATE ON public.clients
    FOR EACH ROW EXECUTE FUNCTION public.set_clients_sync_fields();

-- A plate move changes both visible client snapshots and their CAS versions.
CREATE FUNCTION public.touch_client_for_plate() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE public.clients SET version = version + 1 WHERE id = NEW.client_id;
    ELSIF TG_OP = 'UPDATE' AND (OLD.client_id IS DISTINCT FROM NEW.client_id OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at) THEN
        UPDATE public.clients SET version = version + 1 WHERE id = OLD.client_id;
        IF OLD.client_id IS DISTINCT FROM NEW.client_id THEN
            UPDATE public.clients SET version = version + 1 WHERE id = NEW.client_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER client_plates_after_change AFTER INSERT OR UPDATE ON public.client_plates
    FOR EACH ROW EXECUTE FUNCTION public.touch_client_for_plate();

CREATE FUNCTION public.valid_client_cuit(value text) RETURNS boolean AS $$
DECLARE
    weights integer[] := ARRAY[5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    total integer := 0;
    verifier integer;
BEGIN
    IF value IS NULL OR value !~ '^[0-9]{11}$' THEN RETURN false; END IF;
    FOR index IN 1..10 LOOP
        total := total + substring(value FROM index FOR 1)::integer * weights[index];
    END LOOP;
    verifier := 11 - (total % 11);
    IF verifier = 11 THEN verifier := 0; END IF;
    RETURN verifier <> 10 AND verifier = substring(value FROM 11 FOR 1)::integer;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
ALTER TABLE public.clients ADD CONSTRAINT clients_cuit_valid
    CHECK (cuit IS NULL OR public.valid_client_cuit(cuit));

-- Called by the invoice trigger and by the repeatable backfill. This never
-- overwrites owner-edited names or contact fields.
CREATE FUNCTION public.associate_invoiced_client_plate(
    target_tenant uuid, target_plate text, target_cuit text, target_name text
) RETURNS void AS $$
DECLARE
    normalized_plate text := upper(regexp_replace(target_plate, '[^a-zA-Z0-9]', '', 'g'));
    destination uuid;
    previous uuid;
    clean_name text := nullif(left(trim(target_name), 200), '');
BEGIN
    IF normalized_plate !~ '^[A-Z0-9]{1,20}$' OR NOT public.valid_client_cuit(target_cuit) THEN
        RETURN;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(target_tenant::text || ':' || normalized_plate, 0));
    SELECT id INTO destination FROM public.clients
    WHERE tenant_id = target_tenant AND cuit = target_cuit AND deleted_at IS NULL
    FOR UPDATE;
    IF destination IS NULL THEN
        INSERT INTO public.clients (id, tenant_id, cuit, name)
        VALUES (gen_random_uuid(), target_tenant, target_cuit, clean_name)
        ON CONFLICT (tenant_id, cuit) WHERE deleted_at IS NULL AND cuit IS NOT NULL DO NOTHING
        RETURNING id INTO destination;
        IF destination IS NULL THEN
            SELECT id INTO destination FROM public.clients
            WHERE tenant_id = target_tenant AND cuit = target_cuit AND deleted_at IS NULL
            FOR UPDATE;
        END IF;
    ELSIF clean_name IS NOT NULL THEN
        UPDATE public.clients SET name = clean_name
        WHERE id = destination AND name_edited = false AND name IS DISTINCT FROM clean_name;
    END IF;

    SELECT client_id INTO previous FROM public.client_plates
    WHERE tenant_id = target_tenant AND plate = normalized_plate AND deleted_at IS NULL
    FOR UPDATE;
    IF previous = destination THEN RETURN; END IF;
    IF previous IS NOT NULL THEN
        UPDATE public.client_plates SET deleted_at = now()
        WHERE tenant_id = target_tenant AND plate = normalized_plate AND deleted_at IS NULL;
    END IF;
    INSERT INTO public.client_plates (tenant_id, client_id, plate)
    VALUES (target_tenant, destination, normalized_plate);
    IF previous IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.client_plates WHERE client_id = previous AND deleted_at IS NULL
    ) THEN
        UPDATE public.clients SET deleted_at = now(), version = version + 1
        WHERE id = previous AND deleted_at IS NULL;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

CREATE FUNCTION public.associate_client_after_invoice_issued() RETURNS trigger AS $$
DECLARE
    invoice_plate text;
BEGIN
    IF NEW.status = 'issued' AND OLD.status IS DISTINCT FROM 'issued'
       AND NEW.receptor_doc_tipo = 80 AND NEW.receptor_doc_nro ~ '^[0-9]{11}$' THEN
        SELECT plate INTO invoice_plate FROM public.entries WHERE id = NEW.entry_id AND tenant_id = NEW.tenant_id;
        IF invoice_plate IS NOT NULL THEN
            PERFORM public.associate_invoiced_client_plate(
                NEW.tenant_id, invoice_plate, NEW.receptor_doc_nro, NEW.receptor_nombre
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';
CREATE TRIGGER invoices_after_issued_client AFTER UPDATE ON public.invoices
    FOR EACH ROW EXECUTE FUNCTION public.associate_client_after_invoice_issued();
REVOKE ALL ON FUNCTION public.associate_invoiced_client_plate(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.associate_client_after_invoice_issued() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_plates ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.clients_can_manage(target_tenant uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_memberships m
        WHERE m.user_id = (SELECT auth.uid()) AND m.tenant_id = target_tenant
          AND m.role = 'owner'
    );
$$;
REVOKE ALL ON FUNCTION public.clients_can_manage(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clients_can_manage(uuid) TO authenticated;
REVOKE ALL ON public.clients, public.client_plates FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.clients, public.client_plates TO authenticated;
GRANT USAGE ON SEQUENCE public.clients_sync_seq TO authenticated;
CREATE POLICY clients_read ON public.clients FOR SELECT TO authenticated
    USING (public.lpr_ignored_plates_can_access(tenant_id, false));
CREATE POLICY clients_insert ON public.clients FOR INSERT TO authenticated
    WITH CHECK (public.clients_can_manage(tenant_id));
CREATE POLICY clients_update ON public.clients FOR UPDATE TO authenticated
    USING (public.clients_can_manage(tenant_id))
    WITH CHECK (public.clients_can_manage(tenant_id));
CREATE POLICY client_plates_read ON public.client_plates FOR SELECT TO authenticated
    USING (public.lpr_ignored_plates_can_access(tenant_id, false));
CREATE POLICY client_plates_insert ON public.client_plates FOR INSERT TO authenticated
    WITH CHECK (public.clients_can_manage(tenant_id));
CREATE POLICY client_plates_update ON public.client_plates FOR UPDATE TO authenticated
    USING (public.clients_can_manage(tenant_id))
    WITH CHECK (public.clients_can_manage(tenant_id));
