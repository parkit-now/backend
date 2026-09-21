-- Un solo intento de cobro VIVO por CAJA (`tenant_id`), no sólo por estadía.
--
-- Corrige un hueco de 20260920233000_payment_intents.sql. Ese archivo dejó
-- `payment_intents_entry_live_idx`, que es UNIQUE sobre `entry_id`: impide
-- cobrarle dos veces al MISMO auto, pero NO impide que DOS autos distintos
-- tengan cada uno su orden viva en la MISMA caja. Y eso, con QR estático, es un
-- cobro mal hecho.
--
-- 1. POR QUÉ EL ÍNDICE POR `entry_id` NO ALCANZA: EL QR ES ESTÁTICO.
--
--    El cartel del mostrador es un QR ESTÁTICO (`config.qr.mode = 'static'`,
--    ver `MpApiClient.createOrder`): un PNG impreso que codifica el POS, no la
--    orden. No cambia nunca. Lo que cambia es qué orden tiene ese POS asignada
--    en Mercado Pago en cada instante, y una caja sostiene UNA SOLA orden a la
--    vez.
--
--    Secuencia concreta del fallo, toda dentro de la ventana de 5 minutos:
--
--      t0  el auto A sale, $1.500 → se crea la orden A sobre el POS
--      t1  el auto B sale, $8.000 → se crea la orden B sobre el MISMO POS
--          (pasa el índice por `entry_id`: son estadías distintas)
--      t2  el cliente del auto A escanea el cartel y PAGA $8.000
--
--    El operario del auto A ve "pagado", cierra la estadía A, y el que pagó de
--    más es un tercero que nunca supo qué pasó. Cobrar mal es el peor fallo
--    posible de este sistema: no es un 500 que se reintenta, es plata ajena.
--
--    Los dos índices conviven y guardan cosas DISTINTAS, no se solapan:
--
--      · `payment_intents_entry_live_idx`  → no cobrar dos veces el MISMO auto.
--                                            Incluye `approved`.
--      · `payment_intents_tenant_live_idx` → no encolar dos órdenes en la MISMA
--                                            caja. NO incluye `approved`.
--
-- 2. POR QUÉ `approved` NO ENTRA EN ESTE CONJUNTO, AUNQUE SÍ ENTRE EN EL OTRO.
--
--    Los dos índices responden preguntas distintas y por eso su conjunto de
--    estados vivos es distinto.
--
--    Una vez que Mercado Pago acreditó el pago, la orden YA SE CONSUMIÓ del
--    lado del POS: la caja quedó libre y el próximo auto puede generar la suya.
--    Lo único que falta de nuestro lado es el trámite administrativo (generar
--    la `payment_transactions` y cerrar la estadía), que lo hace el operario a
--    su ritmo y puede demorar minutos.
--
--    Si `approved` entrara acá, la fila de salida entera quedaría trabada hasta
--    que el operario cierre la estadía anterior: un auto pagado y sin cerrar
--    bloquearía el cobro de TODOS los que vienen atrás. Eso es una caja parada
--    por un motivo administrativo, y no es lo que este índice tiene que
--    proteger.
--
--    En `entry_live_idx` sí entra, y por el motivo opuesto: mientras la estadía
--    no se cerró, un segundo intento sobre ELLA sería un segundo cobro al mismo
--    auto.
--
-- 3. 🟡 LA PREMISA "UNA ORDEN POR CAJA" ES INFERENCIA DE ALTA CONFIANZA, A
--    CONFIRMAR EN SANDBOX.
--
--    No está escrita como tal en la documentación de la API de Orders. Sale de
--    la documentación del modelo atendido (QR estático), y son tres señales que
--    apuntan al mismo lado:
--
--      a) La doc habla de "un QR al cual se le asignó UNA orden previamente":
--         singular, y "asignar" es un verbo de estado, no de cola.
--      b) La creación de la orden sobre el QR era un `PUT`, con semántica de
--         REEMPLAZO. Un `PUT` sobre el mismo recurso pisa lo que había.
--      c) Existe un endpoint DEDICADO para eliminar la orden del QR. Si el POS
--         pudiera sostener varias, borrar "la" orden no tendría sentido.
--
--    Falta confirmarlo contra el sandbox con dos órdenes vivas sobre el mismo
--    `external_pos_id`. Hasta entonces, el índice va igual, y la razón es la
--    ASIMETRÍA DEL COSTO DE EQUIVOCARSE:
--
--      · Si la premisa es CIERTA y no ponemos el índice → cobro mal hecho.
--        Irreversible desde el lado del sistema y con plata de un tercero.
--      · Si la premisa es FALSA y ponemos el índice igual → un 409 evitable
--        cuando dos autos salen en la misma ventana de 5 minutos. El operario
--        espera, cancela el intent anterior, o el vencimiento lo barre.
--
--    Un 409 molesto es infinitamente más barato que un cobro equivocado. Si el
--    sandbox demuestra que el POS sostiene varias órdenes, este índice se borra
--    con una migración de una línea y no se pierde nada.
--
-- 4. POR QUÉ NO SE MODIFICA `entry_live_idx` EN LUGAR DE SUMAR OTRO.
--
--    Porque no son la misma regla. Un índice compuesto `(tenant_id, entry_id)`
--    no sirve: permitiría justamente el caso del punto 1 (dos entradas
--    distintas en el mismo tenant). Y ampliar `entry_live_idx` a `tenant_id`
--    perdería la protección del doble cobro por estadía. Son dos invariantes
--    independientes y necesitan dos índices.
--
-- Prisma no sabe expresar índices parciales, así que éste vive sólo acá, en
-- SQL — mismo caso que los otros tres de `payment_intents` y que
-- `mp_accounts_token_expiry_idx`.

CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_tenant_live_idx
    ON payment_intents (tenant_id)
    WHERE status IN ('created', 'pending');

COMMENT ON INDEX payment_intents_tenant_live_idx IS
  'A lo sumo UN intento de cobro vivo por playa: con QR estático el cartel '
  'impreso está atado a un POS y esa caja sostiene una sola orden a la vez, '
  'así que dos órdenes simultáneas hacen que el cliente del primer auto pague '
  'el monto del segundo. `approved` queda AFUERA a propósito: con el pago ya '
  'acreditado la caja está libre y trabarla hasta que el operario cierre la '
  'estadía pararía la fila de salida. Ver la cabecera de la migración '
  '20260921030000.';
