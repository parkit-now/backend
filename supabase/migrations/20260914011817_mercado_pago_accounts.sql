-- Cuenta de Mercado Pago vinculada a una playa: tokens de OAuth + Store/POS del QR.
--
-- Una fila por estacionamiento que completó el flujo de vinculación. Guarda lo
-- único que no se puede volver a pedirle a Mercado Pago sin mandar de nuevo al
-- dueño por el consentimiento: el par de tokens de OAuth. Y guarda además los
-- identificadores del `Store` y del `POS` que se crean después de vincular,
-- porque son los que atan un pago entrante a esta playa.
--
-- Decisiones y el porqué de cada una:
--
-- 1. ESTA TABLA VIVE EN `prisma/schema/global/`, NO EN `tenant/`, AUNQUE TENGA
--    `tenant_id`, Y NO SE REGISTRA EN `TENANT_MODELS`
--    (`src/database/prisma-tenant.ts`).
--
--    El motivo es el cron de refresh de tokens. El `refresh_token` de Mercado
--    Pago tiene vencimiento, así que hay un job que barre TODAS las cuentas
--    por vencer y las renueva. Ese barrido es cross-tenant por definición:
--    recorre las filas de todas las playas de una. `getTenantClient()` exige
--    un tenant en el `AsyncLocalStorage`, que lo pone el `TenantInterceptor`
--    en cada request HTTP — y en un cron NO HAY REQUEST, así que no hay
--    tenant, así que el cliente scopeado explota o (peor) filtra un `WHERE
--    tenant_id` con `undefined`.
--
--    El precedente exacto es `payment_methods`: tiene `tenant_id`, tiene
--    campos de sync, y vive igual en `global/`. Está escrito textual en
--    `src/entities/entities.service.ts:22-27`:
--
--      "`tenants`, `payment_methods` and `audit_log` are GLOBAL tables (not in
--       `TENANT_MODELS`), so this service uses the plain Prisma client
--       filtering by the `:tenantId` from the route (already validated by
--       `TenantMembershipGuard`)."
--
--    O sea: el aislamiento no desaparece, cambia de lugar. Deja de ser
--    automático (extensión de Prisma) y pasa a ser explícito (el service
--    filtra por el `:tenantId` de la ruta, que el `TenantMembershipGuard` ya
--    validó). Quien escriba el service de B2b tiene que filtrar a mano, sí o
--    sí.
--
-- 2. NO LLEVA `sync_seq` NI `version`. El desktop no sincroniza esta tabla y
--    no debería: son tokens de acceso a la plata del dueño, no tienen por qué
--    bajar a una IndexedDB de una máquina en el mostrador. Sin `sync_seq` no
--    hay endpoint de `changes` y sin `version` no hay optimistic locking
--    porque no hay edición concurrente desde clientes: acá escribe el backend
--    (la vinculación) y el cron (el refresh). Sí lleva `updated_at` con
--    trigger propio, para saber cuándo se tocó la fila por última vez.
--
-- 3. `UNIQUE (tenant_id)` SÍ; `UNIQUE (mp_user_id)` NO, Y ES DELIBERADO.
--
--    Una playa tiene a lo sumo una cuenta de Mercado Pago vinculada: eso es el
--    unique de `tenant_id`, y además es lo que permite buscar la cuenta por
--    playa sin ordenar ni desempatar.
--
--    Lo que NO se prohíbe es que el mismo `mp_user_id` aparezca en varias
--    filas, porque es un caso REAL y común: un dueño con tres playas tiene UNA
--    sola cuenta de Mercado Pago y un solo CUIT. Mercado Pago está diseñado
--    justamente para eso — una cuenta puede tener varios `Store` y varios
--    `POS`, que es exactamente cómo se separan las tres playas acá. Un unique
--    sobre `mp_user_id` sería una pared contra un caso legítimo a cambio de
--    absolutamente nada: no protege ninguna invariante, sólo rompe el alta de
--    la segunda playa con un error de base que nadie va a saber leer.
--
-- 4. LOS TOKENS SE GUARDAN CIFRADOS, NUNCA EN PLANO. `access_token` y
--    `refresh_token` son `text` porque lo que entra es el base64 que produce
--    `MpCryptoService` (AES-256-GCM, formato `base64(iv[12] || tag[16] ||
--    ciphertext)`). `token_key_version` dice con qué clave se cifró esa fila,
--    que es lo único que hace posible rotar la clave sin un downtime: se cifra
--    siempre con la activa y se descifra con la que diga la fila. Sin esa
--    columna, rotar es re-cifrar todo el universo en una transacción o perder
--    los tokens.
--
--    El cifrado NO se hace en la base (ni pgcrypto ni Supabase Vault) a
--    propósito: la clave vive en variables de entorno de Cloud Run, así que un
--    dump de la base no alcanza para descifrar nada. El razonamiento completo
--    está en el docstring de `src/mercado-pago/mp-crypto.service.ts`.
--
-- 5. `status` ES UN ENUM Y NO UN BOOLEAN. "Vinculada o no" no alcanza: una
--    cuenta puede estar viva (`linked`), con el refresh vencido y necesitando
--    que el dueño re-autorice (`token_expired`), o desvinculada por el dueño
--    desde su panel de Mercado Pago (`revoked`). Los tres estados llevan a
--    mensajes distintos en la UI y a acciones distintas del cron, y un
--    conjunto cerrado obliga a pasar por migración para inventar uno nuevo.
--
-- 6. `refresh_failure_count` ES UN CONTADOR, NO UN FLAG. El refresh puede
--    fallar por un 500 de Mercado Pago o por una red mala, y marcar la cuenta
--    como muerta al primer error dejaría al dueño sin cobrar por un hipo
--    ajeno. A los 3 fallos consecutivos el cron pasa el `status` a
--    `token_expired`; un refresh exitoso lo vuelve a 0.
--
-- 7. EL ÍNDICE DEL CRON ES PARCIAL. El barrido pregunta siempre lo mismo:
--    "cuentas `linked` cuyo token vence pronto". Un índice sobre
--    `access_token_expires_at` filtrando `WHERE status = 'linked'` sirve a esa
--    query exacta y NO indexa las filas revocadas o vencidas, que son ruido
--    permanente. Prisma no sabe expresar índices parciales, así que este vive
--    sólo acá, en SQL — igual que `payment_methods_tenant_system_type_idx`.
--
-- 8. BACKEND-ONLY: RLS PRENDIDA Y CERO POLICIES. Es la tabla de los tokens; no
--    puede ser alcanzable desde PostgREST ni por casualidad. Mismo patrón que
--    `tenants` (20260505000452_init.sql) y `password_reset_requests`
--    (20260523000000).

CREATE TYPE mp_account_status AS ENUM (
    'linked',
    'token_expired',
    'revoked'
);

CREATE TABLE mp_accounts (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
    mp_user_id               text NOT NULL,
    access_token             text NOT NULL,
    refresh_token            text NOT NULL,
    token_key_version        smallint NOT NULL DEFAULT 1,
    access_token_expires_at  timestamptz NOT NULL,
    status                   mp_account_status NOT NULL DEFAULT 'linked',
    store_id                 text,
    pos_id                   text,
    external_pos_id          text,
    qr_image_url             text,
    qr_template_document_url text,
    refresh_failure_count    integer NOT NULL DEFAULT 0,
    last_refresh_at          timestamptz,
    linked_at                timestamptz NOT NULL DEFAULT now(),
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

-- La query del cron de refresh, y la única razón de este índice: las cuentas
-- vivas ordenadas por vencimiento. Parcial a propósito (ver punto 7).
CREATE INDEX mp_accounts_token_expiry_idx
    ON mp_accounts (access_token_expires_at)
    WHERE status = 'linked';

COMMENT ON TABLE mp_accounts IS
  'Cuenta de Mercado Pago vinculada a una playa: tokens de OAuth cifrados y '
  'el Store/POS que identifica a la playa dentro de la cuenta. Backend-only '
  '(RLS sin policies). Vive en el schema global aunque tenga `tenant_id` '
  'porque el cron de refresh la barre cross-tenant; ver la cabecera de esta '
  'migración.';

COMMENT ON COLUMN mp_accounts.tenant_id IS
  'La playa dueña de la vinculación. UNIQUE: una playa tiene a lo sumo una '
  'cuenta de Mercado Pago vinculada.';

COMMENT ON COLUMN mp_accounts.mp_user_id IS
  'El id del vendedor en Mercado Pago (`user_id` de la respuesta de OAuth). '
  'NO es unique A PROPOSITO: un dueño con varias playas tiene UNA sola cuenta '
  'de Mercado Pago y un solo CUIT, y las separa con un Store/POS por playa, '
  'que es justamente como Mercado Pago espera que se haga. Prohibirlo sería '
  'romper un caso real a cambio de nada. No "arreglar" agregando un unique.';

COMMENT ON COLUMN mp_accounts.access_token IS
  'CIFRADO, nunca en plano: base64(iv[12] || tag[16] || ciphertext) producido '
  'por `MpCryptoService` (AES-256-GCM). La clave vive en el entorno de Cloud '
  'Run, no en la base, así que esto no se puede descifrar desde SQL.';

COMMENT ON COLUMN mp_accounts.refresh_token IS
  'CIFRADO igual que `access_token`. Es el secreto de más valor de la tabla: '
  'con él se renueva el acceso sin volver a pedirle consentimiento al dueño.';

COMMENT ON COLUMN mp_accounts.token_key_version IS
  'Versión de la clave de cifrado con la que se cifraron los tokens DE ESTA '
  'FILA. Se cifra siempre con la clave activa y se descifra con la que diga '
  'la fila: es lo que permite rotar la clave sin re-cifrar todo de golpe ni '
  'perder los tokens viejos.';

COMMENT ON COLUMN mp_accounts.access_token_expires_at IS
  'Cuándo vence el `access_token` (Mercado Pago devuelve `expires_in` en '
  'segundos y el backend lo convierte a instante). Es la columna que ordena '
  'el barrido del cron de refresh.';

COMMENT ON COLUMN mp_accounts.status IS
  '`linked` = vinculada y operativa; `token_expired` = el refresh falló lo '
  'suficiente como para necesitar que el dueño re-autorice; `revoked` = el '
  'dueño desvinculó la app desde Mercado Pago. Conjunto cerrado: sumar un '
  'estado es un cambio de comportamiento y pasa por migración.';

COMMENT ON COLUMN mp_accounts.store_id IS
  'Id del `Store` de Mercado Pago creado para esta playa (POST /users/:id/stores). '
  'Se crea después de vincular, con la dirección estructurada del tenant.';

COMMENT ON COLUMN mp_accounts.pos_id IS
  'Id del `POS` de Mercado Pago (POST /pos). Es la caja contra la que se '
  'genera el QR y lo que ata un pago entrante a esta playa.';

COMMENT ON COLUMN mp_accounts.external_pos_id IS
  'NUESTRO identificador del POS, el que le mandamos a Mercado Pago como '
  '`external_id`. Permite reencontrar o recrear el POS del lado de Mercado '
  'Pago sin depender de que hayamos guardado bien su id.';

COMMENT ON COLUMN mp_accounts.qr_image_url IS
  'URL de la imagen del QR que devuelve la creación del POS. Se guarda para '
  'mostrarla en el panel sin volver a pegarle a la API de Mercado Pago.';

COMMENT ON COLUMN mp_accounts.qr_template_document_url IS
  'URL del PDF imprimible del QR que devuelve la creación del POS: el cartel '
  'que el dueño pega en el mostrador.';

COMMENT ON COLUMN mp_accounts.refresh_failure_count IS
  'Fallos CONSECUTIVOS del refresh de token. Contador y no flag: un 500 de '
  'Mercado Pago o una red mala no pueden dejar a una playa sin cobrar. A los '
  '3 el cron pasa `status` a `token_expired`; un refresh exitoso lo vuelve a 0.';

COMMENT ON COLUMN mp_accounts.last_refresh_at IS
  'Cuándo corrió el último refresh EXITOSO. NULL mientras los tokens sigan '
  'siendo los originales de la vinculación.';

COMMENT ON COLUMN mp_accounts.linked_at IS
  'Cuándo se completó la vinculación. Se conserva separado de `created_at` '
  'porque una re-vinculación reescribe la fila: `created_at` queda como el '
  'día que la playa vinculó por primera vez.';

-- `updated_at` lo mantiene la base, no el que escribe. Mismo patrón que
-- `set_cash_sessions_sync_fields()` (20260609120000_add_cash_sessions.sql:44-59)
-- pero sin `sync_seq` ni `version`, que esta tabla no tiene (ver punto 2).
CREATE OR REPLACE FUNCTION set_mp_accounts_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mp_accounts_before_update
BEFORE UPDATE ON mp_accounts
FOR EACH ROW
EXECUTE FUNCTION set_mp_accounts_updated_at();

ALTER TABLE mp_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mp_accounts FROM anon, authenticated;
-- Sin policies a propósito: solo el service_role saltea RLS.
