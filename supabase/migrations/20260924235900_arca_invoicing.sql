-- Facturación electrónica con ARCA (ex AFIP): cuenta vinculada por playa,
-- tickets del WSAA, facturas por estadía y auditoría de cada llamada.
--
-- Modelo de credenciales: cada playa usa SU PROPIO certificado de ARCA (sin
-- delegación y sin un CUIT de Parkit). La clave privada la genera Parkit y se
-- guarda cifrada con AES-256-GCM (`ARCA_KEY_ENCRYPTION_KEY`, mismo formato que
-- los tokens de Mercado Pago, ver `src/utils/crypto/aes-gcm.ts`).
--
-- Dónde vive cada tabla:
--
-- · `arca_accounts`, `arca_access_tickets` y `arca_requests` son GLOBALES
--   aunque tengan `tenant_id`: el job de mantenimiento las barre cross-tenant
--   y ninguna lleva `sync_seq` (todas las tablas de `prisma/schema/tenant/`
--   lo llevan, sin excepción). Mismo argumento que `mp_accounts` y
--   `payment_intents`: el aislamiento es EXPLÍCITO, el service filtra por el
--   `:tenantId` de la ruta.
-- · `invoices` es TENANT-LOCAL y syncable: el desktop la baja por `/changes`
--   para mostrar el estado de facturación de cada estadía.
--
-- Todas son backend-only: RLS prendida y CERO policies.

-- =========================================================================
-- Enums
-- =========================================================================

CREATE TYPE arca_environment AS ENUM ('homologacion', 'produccion');

CREATE TYPE arca_account_status AS ENUM (
    'pending_certificate',
    'pending_sales_point',
    'linked',
    'cert_expired',
    'unlinked'
);

-- Condición frente al IVA del EMISOR. Decide la letra: Monotributo y Exento
-- emiten C; Responsable Inscripto emite A o B.
CREATE TYPE arca_tax_condition AS ENUM (
    'responsable_inscripto',
    'monotributo',
    'exento'
);

CREATE TYPE invoice_status AS ENUM (
    'not_required',
    'pending',
    'issuing',
    'issued',
    'error'
);

CREATE TYPE payment_method_invoice_mode AS ENUM ('none', 'auto', 'manual');

-- =========================================================================
-- arca_accounts
-- =========================================================================

CREATE TABLE arca_accounts (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
    environment            arca_environment NOT NULL,
    status                 arca_account_status NOT NULL DEFAULT 'pending_certificate',

    cuit                   varchar(11) NOT NULL CHECK (cuit ~ '^[0-9]{11}$'),
    iibb                   varchar(30),
    razon_social           text,
    condicion_iva          arca_tax_condition,
    domicilio_fiscal       text,
    inicio_actividad       date,
    pto_vta                integer CHECK (pto_vta BETWEEN 1 AND 99998),
    pto_vta_constancia_path text,
    iva_rate               numeric(5, 2) NOT NULL DEFAULT 21,

    csr_pem                text,
    cert_pem               text,
    key_encrypted          text,
    key_version            smallint,
    cert_fingerprint       varchar(64),
    cert_expires_at        timestamptz,

    renewal_csr_pem        text,
    renewal_key_encrypted  text,
    renewal_key_version    smallint,
    renewal_prepared_at    timestamptz,

    linked_at              timestamptz,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

-- El barrido del job de renovación (Etapa 3).
CREATE INDEX arca_accounts_cert_expiry_idx
    ON arca_accounts (cert_expires_at)
    WHERE status = 'linked';

COMMENT ON COLUMN arca_accounts.key_encrypted IS
  'Clave privada RSA del certificado, CIFRADA: base64(iv[12] || tag[16] || '
  'ciphertext) con ARCA_KEY_ENCRYPTION_KEY. Nunca en plano.';

COMMENT ON COLUMN arca_accounts.cert_fingerprint IS
  'SHA-256 del certificado en hex. Es la clave de los tickets del WSAA: dos '
  'playas que comparten certificado comparten ticket.';

CREATE OR REPLACE FUNCTION set_arca_accounts_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER arca_accounts_before_update
BEFORE UPDATE ON arca_accounts
FOR EACH ROW
EXECUTE FUNCTION set_arca_accounts_updated_at();

ALTER TABLE arca_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON arca_accounts FROM anon, authenticated;

-- =========================================================================
-- arca_access_tickets
-- =========================================================================

-- Ticket de Acceso del WSAA (~12 h). Pedir uno nuevo teniendo uno vigente da
-- `coe.alreadyAuthenticated`, así que se reusa entre instancias de Cloud Run.
-- La clave es el CERTIFICADO, no la playa.
CREATE TABLE arca_access_tickets (
    cert_fingerprint     varchar(64) NOT NULL,
    service              varchar(64) NOT NULL,
    environment          arca_environment NOT NULL,
    -- `ILoginCredentials` del SDK en JSON, cifrado igual que la clave privada:
    -- mientras está vigente, el token permite operar en nombre del CUIT.
    credentials_encrypted text NOT NULL,
    key_version          smallint NOT NULL,
    expires_at           timestamptz NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (cert_fingerprint, service, environment)
);

ALTER TABLE arca_access_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON arca_access_tickets FROM anon, authenticated;

-- =========================================================================
-- invoices (tenant-local, syncable)
-- =========================================================================

CREATE SEQUENCE invoices_sync_seq;

CREATE TABLE invoices (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- UNIQUE: nunca dos facturas para la misma estadía.
    entry_id                  uuid NOT NULL UNIQUE REFERENCES entries(id) ON DELETE CASCADE,

    status                    invoice_status NOT NULL,
    error_code                varchar(64),
    error_message             text,
    attempts                  integer NOT NULL DEFAULT 0,
    issuing_started_at        timestamptz,

    environment               arca_environment,
    emisor_cuit               varchar(11),
    cbte_tipo                 smallint,
    pto_vta                   integer,
    -- Se persiste ANTES de llamar a ARCA: si la llamada se corta, es lo que
    -- permite reconciliar con FECompConsultar. Si ARCA rechaza, vuelve a NULL.
    cbte_nro                  integer,
    cae                       varchar(14),
    cae_vto                   date,
    cbte_fch                  date,
    fch_serv_desde            date,
    fch_serv_hasta            date,

    receptor_doc_tipo         smallint,
    receptor_doc_nro          varchar(11),
    receptor_nombre           text,
    receptor_condicion_iva_id smallint,

    imp_total                 numeric(12, 2) NOT NULL,
    imp_neto                  numeric(12, 2),
    imp_iva                   numeric(12, 2),
    iva_rate                  numeric(5, 2),

    -- Foto del emisor al emitir: el PDF tiene que decir lo que decía ese día
    -- aunque el dueño después cambie su domicilio o su condición.
    emisor_razon_social       text,
    emisor_domicilio          text,
    emisor_condicion_iva      arca_tax_condition,
    emisor_iibb               varchar(30),
    emisor_inicio_actividad   date,

    issued_by_user_id         uuid,
    issued_at                 timestamptz,
    created_at                timestamptz NOT NULL DEFAULT now(),

    version                   integer NOT NULL DEFAULT 1,
    sync_seq                  integer NOT NULL DEFAULT nextval('invoices_sync_seq'),
    updated_at                timestamptz NOT NULL DEFAULT now()
);

-- La numeración de ARCA es por (CUIT, punto de venta, tipo), y homologación y
-- producción son mundos aparte. Parcial: las pendientes no tienen número.
CREATE UNIQUE INDEX invoices_voucher_number_idx
    ON invoices (environment, emisor_cuit, pto_vta, cbte_tipo, cbte_nro)
    WHERE cbte_nro IS NOT NULL;

CREATE INDEX invoices_tenant_sync_seq_idx ON invoices (tenant_id, sync_seq);
CREATE INDEX invoices_tenant_status_idx   ON invoices (tenant_id, status);
CREATE INDEX invoices_issuing_idx
    ON invoices (issuing_started_at)
    WHERE status = 'issuing';

CREATE OR REPLACE FUNCTION set_invoices_sync_fields()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    NEW.sync_seq   := nextval('invoices_sync_seq');
    IF TG_OP = 'UPDATE' THEN
        NEW.version := OLD.version + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoices_before_update
BEFORE UPDATE ON invoices
FOR EACH ROW
EXECUTE FUNCTION set_invoices_sync_fields();

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON invoices FROM anon, authenticated;

-- =========================================================================
-- arca_requests (auditoría)
-- =========================================================================

CREATE TABLE arca_requests (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    invoice_id    uuid REFERENCES invoices(id) ON DELETE SET NULL,
    operation     varchar(40) NOT NULL,
    request_json  jsonb,
    response_json jsonb,
    error         text,
    duration_ms   integer NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX arca_requests_tenant_created_idx ON arca_requests (tenant_id, created_at);
CREATE INDEX arca_requests_invoice_idx        ON arca_requests (invoice_id);

ALTER TABLE arca_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON arca_requests FROM anon, authenticated;

-- =========================================================================
-- Columnas nuevas en tablas existentes
-- =========================================================================

-- `none` = el medio no se factura; `auto` = se emite al cobrar; `manual` =
-- queda pendiente para emitir desde el Historial. Un medio nuevo nace en
-- `none`: facturar es una decisión explícita del dueño.
ALTER TABLE payment_methods
    ADD COLUMN invoice_mode payment_method_invoice_mode NOT NULL DEFAULT 'none';

-- Checkbox "Facturada" para las playas sin integración (Etapa 4).
ALTER TABLE entries
    ADD COLUMN manually_invoiced boolean NOT NULL DEFAULT false;
