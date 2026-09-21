-- Intento de cobro con QR de Mercado Pago: una fila por "el operador apretó
-- Cobrar con QR sobre esta estadía".
--
-- Es el puente entre una estadía (`entries`) y una `Order` de Mercado Pago.
-- Nace cuando el operador manda a cobrar, vive mientras el cliente escanea y
-- paga, y muere cuando el pago se acredita y se consume (se convierte en una
-- `payment_transactions`), cuando vence, o cuando alguien lo cancela.
--
-- Existe como tabla propia —y no como un par de columnas en `entries`— porque
-- un intento tiene ciclo de vida, vencimiento, identificadores del lado de
-- Mercado Pago y un historial de fracasos que hay que poder mirar. Meter todo
-- eso en `entries` sería ensuciar la tabla más caliente del sistema con ocho
-- columnas que el 95% de las filas tiene en NULL.
--
-- Decisiones y el porqué de cada una:
--
-- 1. ESTA TABLA VIVE EN `prisma/schema/global/`, NO EN `tenant/`, Y NO SE
--    REGISTRA EN `TENANT_MODELS` (`src/database/prisma-tenant.ts`).
--
--    Dos motivos, y los dos son duros:
--
--    a) SUS DOS ESCRITORES PRINCIPALES SON CROSS-TENANT POR DEFINICIÓN. El
--       webhook de Mercado Pago es un endpoint PÚBLICO: llega sin sesión, sin
--       `:tenantId` en la ruta y sin nada en el `AsyncLocalStorage` — la playa
--       se DEDUCE de la fila del intent, que es justamente lo que se está por
--       buscar. Y el reconciliador es un cron: no hay request, así que tampoco
--       hay tenant. `getTenantClient()` exige un tenant en el
--       `AsyncLocalStorage` que pone el `TenantInterceptor` en cada request
--       HTTP; en los dos casos de arriba ese tenant NO EXISTE, con lo cual el
--       cliente scopeado o explota o —peor— filtra un `WHERE tenant_id` con
--       `undefined`.
--
--       Es el MISMO argumento que ya está escrito textual en la cabecera de
--       20260914011817_mercado_pago_accounts.sql para `mp_accounts` (el cron de
--       refresh) y en la de `mp_oauth_states` (el callback sin `:tenantId`).
--
--    b) LOS 10 MODELOS DE `prisma/schema/tenant/` LLEVAN `sync_seq`, SIN UNA
--       SOLA EXCEPCIÓN. Éste no lo lleva (ver punto 2). Meterlo en `tenant/`
--       rompería un invariante que hoy se cumple en el 100% de los casos, y el
--       próximo que escriba un endpoint de `/changes` asumiendo que todo lo de
--       `tenant/` tiene cursor se va a comer un `undefined` en producción.
--
--    El aislamiento NO desaparece, cambia de lugar: deja de ser automático (la
--    extensión de Prisma inyecta el `WHERE tenant_id`) y pasa a ser EXPLÍCITO
--    —el service filtra a mano por el `:tenantId` de la ruta, que el
--    `TenantMembershipGuard` ya validó—. Precedentes exactos: `payment_methods`
--    y `mp_accounts`. El razonamiento está escrito en
--    `src/entities/entities.service.ts:22-27`. Olvidarse de ese filtro acá es
--    una fuga entre playas, sin red abajo.
--
-- 2. NO LLEVA `sync_seq` NI `version`, Y LAS DOS AUSENCIAS TIENEN MOTIVOS
--    DISTINTOS.
--
--    SIN `sync_seq`: el desktop NO sincroniza esta tabla por `/changes`. La
--    consulta por un endpoint dedicado, con polling cada ~5 segundos, y sólo
--    mientras el modal de cobro está abierto. Un intent vive minutos y le
--    importa a UNA pantalla; bajarlo a la IndexedDB del mostrador por el mismo
--    canal que las estadías sería pagar el costo de un cursor permanente para
--    un dato que caduca en cinco minutos. Sin `sync_seq` no hay endpoint de
--    `changes`, y eso es a propósito.
--
--    SIN `version`: no hay optimistic locking porque NO HAY EDICIÓN
--    CONCURRENTE DESDE CLIENTES. Todas las transiciones de estado son
--    `updateMany` con una guarda `WHERE status IN (...)` en la misma sentencia:
--    el primero que llega gana y el segundo actualiza 0 filas y se entera por
--    el `count`. Eso ya es control de concurrencia, y es MEJOR que un `version`
--    acá, porque el webhook y el cron no tienen de dónde sacar la versión que
--    leyeron (no leyeron nada: llegan con un `mp_order_id` y nada más).
--
--    Sí lleva `updated_at` con trigger propio, para saber cuándo se tocó la
--    fila por última vez.
--
-- 3. EL ENUM NACE ACÁ, ASÍ QUE SE CREA Y SE USA EN LA MISMA MIGRACIÓN.
--
--    Esto no es la trampa de Postgres, es su prima inofensiva. Lo que Postgres
--    prohíbe es `ALTER TYPE ... ADD VALUE` sobre un enum YA EXISTENTE y después
--    usar ese valor nuevo en la misma transacción. Acá el tipo se crea de cero
--    en este archivo, con lo cual sus valores son visibles de inmediato y el
--    `CREATE TABLE` de abajo puede usarlos. No hay por qué partir esto en dos
--    migraciones.
--
-- 4. `charged_back` ENTRA AL ENUM DESDE AHORA AUNQUE TODAVÍA NO SE CONSUMA.
--
--    Mercado Pago tiene una acción de webhook `order.charged_back` (contracargo
--    del comprador). Todavía no la manejamos, pero agregar un valor al enum
--    DESPUÉS sí cae en la trampa del punto 3: obliga a una migración aparte
--    sólo para el `ALTER TYPE`, y otra para usarlo. Un valor de enum que nadie
--    escribe no cuesta nada; una migración partida en dos sí. Se paga ahora.
--
-- 5. `payment_intents_entry_live_idx` ES LA RESTRICCIÓN QUE EVITA EL DOBLE
--    COBRO, Y ES LO MÁS IMPORTANTE DE ESTE ARCHIVO.
--
--    Un índice UNIQUE PARCIAL sobre `entry_id` filtrando por los estados vivos
--    (`created`, `pending`, `approved`) hace IMPOSIBLE que una estadía tenga
--    dos intentos abiertos a la vez. Sin él, dos clicks seguidos en "Cobrar con
--    QR" —o un reintento del desktop tras un timeout— generan dos órdenes en
--    Mercado Pago y el cliente puede pagar las dos. Esto NO se puede resolver
--    con un `SELECT` previo desde la aplicación: entre el `SELECT` y el
--    `INSERT` hay una ventana, y es exactamente la ventana que el doble click
--    encuentra.
--
--    Es parcial porque los estados terminales (`consumed`, `expired`,
--    `canceled`, `failed`, `refunded`, `charged_back`) SÍ se pueden repetir: una
--    estadía cuyo primer intento venció tiene que poder generar el segundo.
--
--    Mismo patrón exacto que `cash_sessions_tenant_open_idx`
--    (20260609120000_add_cash_sessions.sql:36-38): una sola caja abierta por
--    playa, cerradas las que quiera. Prisma no sabe expresar índices parciales,
--    así que éste vive sólo acá, en SQL.
--
-- 6. LOS CAMPOS `mp_*` SON UN ESPEJO CRUDO, NO LA FUENTE DE VERDAD.
--
--    `status` (nuestro) es el que manda el comportamiento del sistema.
--    `mp_status` y `mp_status_detail` guardan el texto TAL CUAL lo manda
--    Mercado Pago, sin traducir y sin enum, y existen para una sola cosa:
--    diagnosticar. Cuando un pago quede en un estado raro, la diferencia entre
--    "no sé qué pasó" y "MP dijo `processed`/`partially_refunded`" son estas
--    dos columnas. Son `text` y no enum a propósito: MP puede sumar un
--    `status_detail` mañana y eso NO puede tirar abajo el webhook con un error
--    de enum inválido.
--
-- 7. `created_by_user_id` NO TIENE `NOT NULL` Y SU FK ES `ON DELETE SET NULL`.
--
--    Es la misma decisión que `audit_log.actor_user_id`
--    (20260531221650_add_onboarding.sql:147): `uuid REFERENCES users(id) ON
--    DELETE SET NULL`. El motivo es idéntico: borrar un operador no puede
--    borrar ni bloquear el historial de cobros que generó. La FK se conserva
--    (queremos integridad referencial mientras el usuario exista), pero el
--    borrado degrada el dato a "no sabemos quién fue" en vez de fallar o
--    cascadear. Y es nullable porque el reconciliador y el webhook también
--    escriben filas, y ahí no hay usuario.
--
-- 8. BACKEND-ONLY: RLS PRENDIDA Y CERO POLICIES. Un intent lleva el monto a
--    cobrar y el id de la orden del lado de Mercado Pago; no puede ser
--    alcanzable desde PostgREST ni por casualidad. Mismo patrón que
--    `mp_accounts`, `tenants` (20260505000452_init.sql) y
--    `password_reset_requests` (20260523000000).

CREATE TYPE payment_intent_status AS ENUM (
    'created',
    'pending',
    'approved',
    'consumed',
    'expired',
    'canceled',
    'failed',
    'refunded',
    'charged_back'
);

CREATE TABLE IF NOT EXISTS payment_intents (
    id                     uuid PRIMARY KEY,
    tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    entry_id               uuid NOT NULL REFERENCES entries(id),
    status                 payment_intent_status NOT NULL DEFAULT 'created',
    amount                 numeric(12,2) NOT NULL,
    mp_order_id            text,
    mp_status              text,
    mp_status_detail       text,
    expires_at             timestamptz NOT NULL,
    approved_at            timestamptz,
    consumed_at            timestamptz,
    payment_transaction_id uuid,
    failure_reason         text,
    created_by_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Un intento de cobrar $0 (o negativo) no es un caso de borde: es un bug del
-- motor de cobro que llegó hasta la base. Mercado Pago lo rechazaría igual,
-- pero con un 400 opaco y después de haber creado la fila.
ALTER TABLE payment_intents
  DROP CONSTRAINT IF EXISTS payment_intents_amount_positive;

ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_amount_positive
  CHECK (amount > 0);

-- 🔴 LA restricción que evita el doble cobro de la misma estadía: a lo sumo UN
-- intento vivo por `entry_id`. Ver el punto 5 de la cabecera antes de tocarlo.
CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_entry_live_idx
    ON payment_intents (entry_id)
    WHERE status IN ('created', 'pending', 'approved');

-- El webhook llega con el `order_id` de Mercado Pago y NADA más: sin este
-- índice, cada notificación es un seq scan de la tabla entera. UNIQUE porque
-- una orden de MP mapea a exactamente un intent nuestro, y parcial porque el
-- `mp_order_id` está en NULL entre el INSERT y la respuesta de `POST /v1/orders`
-- (y se queda en NULL para siempre si esa llamada nunca llegó a completarse).
CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_mp_order_id_key
    ON payment_intents (mp_order_id)
    WHERE mp_order_id IS NOT NULL;

-- La query del barrido de vencimientos: intentos todavía abiertos ordenados por
-- `expires_at`. Parcial a propósito, igual que `mp_accounts_token_expiry_idx`:
-- los terminales son ruido permanente y crecen sin techo.
CREATE INDEX IF NOT EXISTS payment_intents_open_expiring_idx
    ON payment_intents (expires_at)
    WHERE status IN ('created', 'pending');

-- El listado del panel por playa, que siempre filtra por estado.
CREATE INDEX IF NOT EXISTS payment_intents_tenant_status_idx
    ON payment_intents (tenant_id, status);

COMMENT ON TABLE payment_intents IS
  'Intento de cobro con QR de Mercado Pago: el puente entre una estadía y una '
  'Order de MP. Backend-only (RLS sin policies). Vive en el schema global '
  'aunque tenga `tenant_id` porque el webhook (público, sin tenant) y el '
  'reconciliador (cron, sin request) la escriben cross-tenant; ver la cabecera '
  'de esta migración.';

COMMENT ON COLUMN payment_intents.id IS
  'UUIDv7 generado por el cliente, igual que `entries` y `cash_sessions`: sin '
  '`DEFAULT` a propósito. Es además el `external_reference` que viaja a Mercado '
  'Pago (36 chars, sólo hex y guiones: entra holgado en el máximo de 64 y '
  'cumple el charset que MP exige).';

COMMENT ON COLUMN payment_intents.entry_id IS
  'La estadía que se está cobrando. Un solo intento VIVO por estadía, garantizado '
  'por `payment_intents_entry_live_idx`: es lo que evita el doble cobro cuando el '
  'operador hace doble click o el desktop reintenta tras un timeout.';

COMMENT ON COLUMN payment_intents.status IS
  'NUESTRO estado, el que manda el comportamiento. Vivos: `created` (la fila '
  'existe, la order puede o no existir del lado de MP), `pending` (la order '
  'existe y espera el escaneo), `approved` (MP acreditó, falta consumirlo). '
  'Terminales: `consumed` (ya generó su `payment_transactions`), `expired`, '
  '`canceled`, `failed`, `refunded`, `charged_back`. Sólo los tres vivos entran '
  'al índice único por estadía.';

COMMENT ON COLUMN payment_intents.amount IS
  'El monto a cobrar, congelado al crear el intento. NO se recalcula: la '
  'recuperación de un intent en `created` re-POSTea el MISMO body a MP con la '
  'misma `X-Idempotency-Key`, y un monto recalculado (aunque sea por un minuto '
  'más de estadía) cambia el body y hace que MP conteste 409 en vez de devolver '
  'la orden original. Ver el docblock de `MpApiClient.createOrder`.';

COMMENT ON COLUMN payment_intents.mp_order_id IS
  'El `id` de la Order del lado de Mercado Pago. NULL entre el INSERT y la '
  'respuesta de `POST /v1/orders` — y también cuando esa llamada murió por '
  'timeout y no sabemos si la orden existe. Ese hueco es exactamente el caso que '
  'resuelve el re-POST idempotente.';

COMMENT ON COLUMN payment_intents.mp_status IS
  'El `status` CRUDO que manda Mercado Pago (`created`, `processed`, `canceled`, '
  '`refunded`, `expired`), sin traducir. Es `text` y no enum a propósito: MP '
  'puede sumar un valor mañana y eso no puede tirar abajo el webhook con un '
  'error de enum inválido. Sirve para diagnosticar, no para decidir.';

COMMENT ON COLUMN payment_intents.mp_status_detail IS
  'El `status_detail` CRUDO de Mercado Pago (`created`, `canceled`, '
  '`accredited`, `refunded`, `expired`, `partially_refunded`). Mismo criterio '
  'que `mp_status`: espejo para diagnóstico, no fuente de verdad.';

COMMENT ON COLUMN payment_intents.expires_at IS
  'Cuándo deja de servir este intento. Se calcula UNA vez al crearlo, a partir '
  'del mismo TTL que viaja a MP como `expiration_time` (duración relativa ISO '
  '8601, p. ej. `PT5M`). Lo barre el reconciliador con '
  '`payment_intents_open_expiring_idx`.';

COMMENT ON COLUMN payment_intents.approved_at IS
  'Cuándo Mercado Pago acreditó el pago. Es el instante que reporta MP, no el de '
  'nuestro reloj: entre que el cliente paga y el webhook llega puede haber '
  'minutos, y el comprobante tiene que decir cuándo se pagó.';

COMMENT ON COLUMN payment_intents.consumed_at IS
  'Cuándo el intento se convirtió en una `payment_transactions` y cerró la '
  'estadía. Junto con `payment_transaction_id` es el candado de un solo uso: un '
  'intento `approved` se consume UNA vez, con un UPDATE condicional sobre el '
  'estado, y el segundo intento de consumirlo actualiza 0 filas.';

COMMENT ON COLUMN payment_intents.payment_transaction_id IS
  'El cobro que este intento generó al consumirse. Se llena en B5. SIN FK a '
  '`payment_transactions` a propósito: esa tabla es tenant-local y tiene borrado '
  'lógico (`deleted_at`), así que una FK acá ataría una tabla global a una '
  'tenant-local para ganar nada — el vínculo se navega desde el service, que ya '
  'filtra por tenant.';

COMMENT ON COLUMN payment_intents.failure_reason IS
  'Por qué falló, en texto libre y para humanos. Lo escribe el backend cuando '
  'pasa a `failed`. NUNCA lleva tokens ni datos personales del pagador: lo lee '
  'soporte y termina en logs y exports.';

COMMENT ON COLUMN payment_intents.created_by_user_id IS
  'Qué operador mandó a cobrar. `ON DELETE SET NULL` igual que '
  '`audit_log.actor_user_id`: borrar un empleado no puede borrar ni bloquear el '
  'historial de cobros que generó. Nullable además porque el webhook y el '
  'reconciliador también escriben, y ahí no hay usuario.';

-- `updated_at` lo mantiene la base, no el que escribe. Calcado de
-- `set_mp_accounts_updated_at()` (20260914011817_mercado_pago_accounts.sql):
-- sin `sync_seq` ni `version`, que esta tabla no tiene (ver punto 2).
CREATE OR REPLACE FUNCTION set_payment_intents_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_intents_before_update ON payment_intents;

CREATE TRIGGER payment_intents_before_update
BEFORE UPDATE ON payment_intents
FOR EACH ROW
EXECUTE FUNCTION set_payment_intents_updated_at();

ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON payment_intents FROM anon, authenticated;
-- Sin policies a propósito: solo el service_role saltea RLS.
