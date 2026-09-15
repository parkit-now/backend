-- El `state` del OAuth de Mercado Pago: un solo uso, TTL de 10 minutos.
--
-- El flujo de vinculación arranca en un request ("llevame a autorizar") y
-- termina en OTRO request, el callback que manda Mercado Pago con el
-- `authorization_code`. Entre los dos hay que recordar tres cosas: qué playa
-- inició el flujo, qué usuario lo inició, y el `code_verifier` de PKCE que
-- después hay que presentar para canjear el código. Eso es esta tabla.
--
-- Decisiones y el porqué de cada una:
--
-- 1. POR QUÉ UNA TABLA Y NO UN `Map` EN MEMORIA.
--
--    Un `Map<state, datos>` en el proceso es la solución obvia y ANDA EN LA
--    MÁQUINA DEL QUE LA ESCRIBE, que es justamente lo que la hace peligrosa.
--    En producción esto corre en Cloud Run, que autoescala: hay N instancias
--    del mismo proceso y el balanceador manda cada request a la que se le
--    canta. El `/authorize` puede salir de la instancia A y el callback de
--    Mercado Pago caer en la instancia B, que no tiene ni idea de ese `state`
--    ni del `code_verifier`. El OAuth falla.
--
--    Y falla del peor modo posible: INTERMITENTE. Con poco tráfico hay una
--    sola instancia y anda siempre; con carga aparece una segunda y empieza a
--    fallar "a veces", sin patrón, sin error claro y sin forma de reproducirlo
--    en local, donde siempre hay una sola instancia. Un deploy o un scale-down
--    tiran el `Map` entero y cortan todos los flujos en vuelo. Esto es estado
--    compartido entre requests: va a la base, que es el único lugar que todas
--    las instancias ven igual.
--
-- 2. LA TABLA VIVE EN `prisma/schema/global/` Y NO SE REGISTRA EN
--    `TENANT_MODELS`, POR EL MISMO MOTIVO QUE `mp_accounts`: la purga de
--    states vencidos es un barrido cross-tenant, sin request y por lo tanto
--    sin tenant en el `AsyncLocalStorage` que `getTenantClient()` necesita.
--    Además, el callback de Mercado Pago llega SIN `:tenantId` en la ruta —
--    la playa se deduce justamente de esta fila— así que ni siquiera hay de
--    dónde sacar el scope. El precedente es `payment_methods`, global a pesar
--    de tener `tenant_id`; está documentado en
--    `src/entities/entities.service.ts:22-27`.
--
--    Corolario para el service que haga el canje: el `tenant_id` de esta fila
--    NO es un dato que mandó el cliente, es el que se guardó al iniciar el
--    flujo. Es la única fuente de verdad de a qué playa vincular, y por eso el
--    `state` tiene que ser imposible de adivinar (uuid v4 de `randomUUID()`).
--
-- 3. UN SOLO USO, Y SE MARCA EN LA MISMA TRANSACCIÓN DEL CANJE.
--    `consumed_at` no es auditoría: es el candado contra replay. Si el canje y
--    el marcado no van en la MISMA transacción, dos callbacks simultáneos con
--    el mismo `state` (un reintento del navegador, un doble click, un atacante
--    repitiendo la URL) pueden canjear los dos. El patrón es un UPDATE
--    condicional —`SET consumed_at = now() WHERE state = $1 AND consumed_at IS
--    NULL AND expires_at > now()`— y seguir sólo si actualizó una fila.
--
-- 4. TTL DE 10 MINUTOS, IGUAL QUE EL `authorization_code` DE MERCADO PAGO.
--    No tiene sentido guardar un `state` más tiempo del que vive el código que
--    va a canjear: pasados los 10 minutos la fila ya no sirve para nada y
--    dejarla viva sólo agranda la ventana de replay. `expires_at` es una
--    columna y no un `now() + interval` calculado al leer porque así el TTL
--    queda escrito en el dato: cambiarlo no reinterpreta las filas viejas.
--
-- 5. NO HAY `sync_seq`, NI `version`, NI `updated_at`. El desktop no sincroniza
--    esto y la fila es inmutable salvo por el único UPDATE que la consume; no
--    hay nada que versionar ni concurrencia que resolver más allá del punto 3.
--
-- 6. EL ÍNDICE ES PARA LA PURGA. El job periódico borra por `expires_at`
--    (`DELETE FROM mp_oauth_states WHERE expires_at < now()`). Sin índice eso
--    es un seq scan sobre una tabla que crece con cada intento de vinculación.
--
-- 7. BACKEND-ONLY: RLS PRENDIDA Y CERO POLICIES. El `code_verifier` es el
--    secreto de PKCE: quien lo lee junto con el `state` puede completar el
--    canje en lugar del dueño. Inalcanzable desde PostgREST, mismo patrón que
--    `tenants` (20260505000452_init.sql) y `password_reset_requests`
--    (20260523000000).

CREATE TABLE mp_oauth_states (
    state         uuid PRIMARY KEY,
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_verifier text NOT NULL,
    return_path   text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    consumed_at   timestamptz
);

-- La query de la purga y la única razón de este índice (ver punto 6).
CREATE INDEX mp_oauth_states_expires_at_idx
    ON mp_oauth_states (expires_at);

COMMENT ON TABLE mp_oauth_states IS
  'El `state` de un flujo de OAuth de Mercado Pago en vuelo: un solo uso, TTL '
  'de 10 minutos. Está en la base y no en memoria porque Cloud Run autoescala '
  'y el callback puede caer en otra instancia; ver la cabecera de esta '
  'migración. Backend-only (RLS sin policies).';

COMMENT ON COLUMN mp_oauth_states.state IS
  'El parámetro `state` del OAuth, uuid v4 de `randomUUID()`. Tiene que ser '
  'imposible de adivinar: es lo único que ata el callback al flujo que lo '
  'inició, y de esta fila sale a qué playa se vincula la cuenta.';

COMMENT ON COLUMN mp_oauth_states.tenant_id IS
  'La playa que inició la vinculación. NO viene del callback: se guarda al '
  'arrancar el flujo y es la única fuente de verdad de a qué playa vincular.';

COMMENT ON COLUMN mp_oauth_states.user_id IS
  'Quién inició la vinculación. Sirve para auditar y para chequear al volver '
  'que el que completa el flujo sigue teniendo permiso sobre la playa.';

COMMENT ON COLUMN mp_oauth_states.code_verifier IS
  'El `code_verifier` de PKCE (S256). Se genera al iniciar, viaja sólo como '
  'hash (`code_challenge`) hacia Mercado Pago, y se presenta en claro recién '
  'al canjear el `authorization_code`. Es un secreto: sin él, un código '
  'robado no se puede canjear.';

COMMENT ON COLUMN mp_oauth_states.return_path IS
  'A dónde volver en el front después del callback (ruta relativa de la app). '
  'Se guarda acá y no en la URL de retorno para que el callback no acepte un '
  'destino arbitrario. Validar que sea una ruta interna antes de redirigir.';

COMMENT ON COLUMN mp_oauth_states.expires_at IS
  'Vencimiento del state: 10 minutos, el mismo TTL que el '
  '`authorization_code` de Mercado Pago. Guardar más tiempo del que vive el '
  'código sólo agranda la ventana de replay.';

COMMENT ON COLUMN mp_oauth_states.consumed_at IS
  'Cuándo se canjeó este state. NO es auditoría: es el candado de un solo '
  'uso. Se marca en la MISMA transacción del canje, con un UPDATE '
  'condicional sobre `consumed_at IS NULL`; si no actualizó ninguna fila, el '
  'callback es un replay y se rechaza.';

ALTER TABLE mp_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mp_oauth_states FROM anon, authenticated;
-- Sin policies a propósito: solo el service_role saltea RLS.
