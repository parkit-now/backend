-- Run after 20261008130000_clients_by_plate.sql. Repeatable: only the latest
-- issued CUIT invoice for each tenant/plate wins, and existing contacts stay.
WITH latest AS (
    SELECT DISTINCT ON (i.tenant_id, upper(regexp_replace(e.plate, '[^a-zA-Z0-9]', '', 'g')))
        i.tenant_id, e.plate, i.receptor_doc_nro AS cuit, i.receptor_nombre AS name
    FROM public.invoices i
    JOIN public.entries e ON e.id = i.entry_id AND e.tenant_id = i.tenant_id
    WHERE i.status = 'issued' AND i.receptor_doc_tipo = 80
      AND i.receptor_doc_nro ~ '^[0-9]{11}$' AND e.deleted_at IS NULL
    ORDER BY i.tenant_id, upper(regexp_replace(e.plate, '[^a-zA-Z0-9]', '', 'g')),
             i.issued_at DESC NULLS LAST, i.updated_at DESC, i.id DESC
)
SELECT public.associate_invoiced_client_plate(tenant_id, plate, cuit, name) FROM latest;
