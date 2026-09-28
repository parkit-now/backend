-- Etapa 5 (Factura A): receptores con CUIT consultados en el padrón de ARCA.
--
-- Cumple dos funciones:
-- · Caché del padrón: la constancia de inscripción tarda y ARCA la limita.
--   Un CUIT encontrado se reusa 30 días; uno que ARCA no tiene, 1 día (puede
--   inscribirse). La emisión usa la misma fila que vio el operario al
--   tipearlo, así la letra que se le mostró es la que sale.
-- · Sugerencias en el cobro: los CUIT ya facturados (`last_used_at`), del más
--   reciente al más viejo.
--
-- GLOBAL aunque tenga `tenant_id`, como `arca_requests`: no se sincroniza (sin
-- `sync_seq`) y el service filtra a mano por el `:tenantId` de la ruta.
-- Backend-only: RLS prendida y cero policies.

CREATE TABLE invoice_receivers (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    cuit                      varchar(11) NOT NULL,
    razon_social              text,
    -- `CondicionIVAReceptorId` de ARCA según el padrón. NULL = ARCA no tiene
    -- datos de este CUIT.
    condicion_iva_receptor_id smallint,
    fetched_at                timestamptz NOT NULL,
    last_used_at              timestamptz,
    created_at                timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT invoice_receivers_tenant_cuit_key UNIQUE (tenant_id, cuit)
);

CREATE INDEX invoice_receivers_tenant_used_idx
    ON invoice_receivers (tenant_id, last_used_at DESC)
    WHERE last_used_at IS NOT NULL;

ALTER TABLE invoice_receivers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON invoice_receivers FROM anon, authenticated;
