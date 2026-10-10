CREATE TYPE public.arca_account_role AS ENUM ('primary', 'secondary');

ALTER TABLE public.arca_accounts
  ADD COLUMN role public.arca_account_role NOT NULL DEFAULT 'primary';
ALTER TABLE public.arca_accounts DROP CONSTRAINT arca_accounts_tenant_id_key;
ALTER TABLE public.arca_accounts ADD CONSTRAINT arca_accounts_tenant_id_id_key UNIQUE (tenant_id, id);
CREATE INDEX arca_accounts_tenant_id_idx ON public.arca_accounts (tenant_id);
CREATE UNIQUE INDEX arca_accounts_active_role_idx
  ON public.arca_accounts (tenant_id, role) WHERE status <> 'unlinked';
CREATE UNIQUE INDEX arca_accounts_active_issuer_idx
  ON public.arca_accounts (tenant_id, environment, cuit, pto_vta)
  WHERE status <> 'unlinked' AND pto_vta IS NOT NULL;

ALTER TABLE public.invoices ADD COLUMN arca_account_id uuid;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_arca_account_fkey
  FOREIGN KEY (tenant_id, arca_account_id) REFERENCES public.arca_accounts (tenant_id, id);
CREATE INDEX invoices_arca_account_idx ON public.invoices (arca_account_id);

-- Only associate known emitters or invoices that have never had an emitter.
-- Normal sync triggers publish the new identity to installed desktops.
UPDATE public.invoices i SET arca_account_id = a.id
FROM public.arca_accounts a
WHERE a.tenant_id = i.tenant_id AND a.role = 'primary'
  AND ((i.environment = a.environment AND i.emisor_cuit = a.cuit AND i.pto_vta = a.pto_vta)
    OR (i.emisor_cuit IS NULL AND i.cbte_nro IS NULL AND a.status <> 'unlinked'
      AND i.status IN ('pending', 'error', 'not_required')));

ALTER TABLE public.entries
  ADD COLUMN manual_invoice_arca_account_id uuid,
  ADD COLUMN manual_invoice_issuer_cuit varchar(11),
  ADD COLUMN manual_invoice_issuer_name text;
ALTER TABLE public.entries ADD CONSTRAINT entries_external_arca_account_fkey
  FOREIGN KEY (tenant_id, manual_invoice_arca_account_id) REFERENCES public.arca_accounts (tenant_id, id);
