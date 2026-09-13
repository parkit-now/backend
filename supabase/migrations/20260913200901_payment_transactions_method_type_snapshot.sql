-- El arqueo de caja deja de adivinar el efectivo por el NOMBRE: el cobro
-- guarda también el TIPO del medio de pago.
--
-- POR QUÉ: EL FIX ANTERIOR TAPÓ EL SÍNTOMA, NO LA CAUSA
--
-- `20260913163737_payment_methods_spanish_default_names.sql` renombró los
-- métodos del sistema a 'Efectivo'/'Transferencia' para que esta regla del
-- desktop diera true (front-desktop/src/features/entries/entryUtils.ts):
--
--     export function isCashMethod(name: string): boolean {
--       return name.toLowerCase().includes('efectivo');
--     }
--
-- Esa migración lo dice con todas las letras: "Arreglar isCashMethod para que
-- mire type es el fix correcto de fondo y queda pendiente". Este es ese fix.
--
-- Decidir por el nombre está mal en las DOS direcciones, y las dos son plata:
--
--   * FALSO NEGATIVO — el dueño renombra su método a "Caja" o "Contado"
--     (tiene todo el derecho: `payment_methods.name` es editable y es lo que
--     ve en pantalla). `'caja'.includes('efectivo')` es false, así que su
--     propio arqueo deja de contarle el efectivo. El esperado en caja le da de
--     menos y la diferencia aparece como faltante del operador.
--
--   * FALSO POSITIVO — alguien crea un método `type='other'` llamado
--     "Efectivo Mercado Pago" (plausible: la plata entra por MP, no al cajón).
--     El arqueo lo suma al efectivo esperado y le reclama al operador plata
--     que nunca tuvo en la mano.
--
-- LA COMPLICACIÓN: EL ARQUEO NO LEE `payment_methods`, LEE UN SNAPSHOT
--
-- No alcanza con que `isCashMethod` mire `payment_methods.type`, porque el
-- cierre de caja nunca toca esa tabla. Lee la columna desnormalizada
-- `payment_transactions.payment_method_name`, que es una COPIA hecha al
-- momento del cobro (front-desktop/src/features/entries/ExitModal.tsx).
--
-- Y el nombre está congelado A PROPÓSITO: el medio se puede renombrar o
-- BORRAR (por eso `payment_method_id` es NULLABLE y no tiene FK), y el
-- comprobante histórico tiene que seguir diciendo lo que decía el día del
-- cobro. Resolver el tipo con un JOIN al momento de arquear tendría tres
-- problemas: falla si el método ya no existe, reescribe la historia si el
-- dueño le cambia el tipo, y no funciona OFFLINE, que es el modo normal del
-- desktop (el arqueo se calcula sobre Dexie, sin backend a mano).
--
-- Entonces el tipo se trata igual que el nombre: se SNAPSHOTEA. Misma
-- filosofía que el resto de la tabla `entries` (`rate_snapshot_name`,
-- `rate_snapshot_hour_price_ars`, `vehicle_type`).
--
-- QUÉ HACE ESTA MIGRACIÓN
--
--   1. Agrega `payment_method_type` (el mismo enum `payment_method_type` que
--      usa `payment_methods`; no se agregan valores, sólo se usa).
--   2. Backfill en dos pasadas, la buena primero.
--   3. La deja NOT NULL, sin DEFAULT.
--
-- POR QUÉ NOT NULL Y SIN DEFAULT
--
-- Un DEFAULT 'other' sería exactamente el bug de nuevo, pero silencioso: un
-- cliente viejo que inserta sin la columna escribiría 'other' sobre un cobro
-- en efectivo y la plata volvería a desaparecer del arqueo, esta vez sin que
-- ningún nombre delate el problema. Preferimos que NO exista el atajo: el
-- backend resuelve el tipo siempre (ver `resolvePaymentLineTypes()` en
-- src/entries/entries.service.ts) y lo escribe explícito.
--
-- NOT NULL, además, es lo que le permite al desktop hacer `type === 'cash'`
-- sin ramas: toda fila que venga del servidor tiene tipo.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. La columna, nullable por ahora para poder backfillear.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS payment_method_type payment_method_type;

-- ─────────────────────────────────────────────────────────────────────────
-- 2a. BACKFILL, PASADA BUENA: resolver contra `payment_methods` por id.
--
-- Esta pasada es EXACTA, no heurística: `payment_method_id` es el id real del
-- medio con el que se cobró. El nombre de ese medio puede haber cambiado mil
-- veces desde entonces; el tipo es lo que la app nunca dejó cambiar.
--
-- El JOIN filtra por `tenant_id` además de por id: los ids son uuid y no se
-- repiten, pero esta tabla es multi-tenant y un JOIN sin tenant en una tabla
-- de plata es una bomba esperando un uuid mal generado.
-- ─────────────────────────────────────────────────────────────────────────
UPDATE payment_transactions pt
   SET payment_method_type = pm.type
  FROM payment_methods pm
 WHERE pt.payment_method_id = pm.id
   AND pt.tenant_id = pm.tenant_id
   AND pt.payment_method_type IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 2b. BACKFILL, PASADA HEURÍSTICA: inferir del nombre.
--
-- Sólo llegan acá las filas que la pasada 2a no pudo resolver:
--   * `payment_method_id` NULL (cobros viejos previos a la columna), o
--   * el id apunta a un método YA BORRADO (no hay FK, a propósito).
--
-- LA HEURÍSTICA, y esto es lo importante, ES LA MISMA REGLA VIEJA:
--
--     nombre contiene 'efectivo'      -> cash
--     nombre contiene 'transferencia' -> transfer
--     cualquier otra cosa             -> other
--
-- Se usa acá porque para estas filas NO HAY MEJOR INFORMACIÓN DISPONIBLE: el
-- único rastro que quedó del medio es el nombre que se copió ese día. Sobre
-- ese universo la regla vieja es lo mejor que se puede hacer, y encima es
-- conservadora: reproduce exactamente lo que el arqueo venía mostrando para
-- esas filas, así que ningún cierre ya firmado cambia de número por esta
-- migración.
--
-- SU LÍMITE, explícito, para que nadie la tome por exacta:
--
--   * FALSO NEGATIVO: un cobro en efectivo cuyo método se llamaba "Caja",
--     "Contado" o "Mostrador" y que además ya fue borrado, queda 'other'. No
--     hay forma de saberlo: el tipo no se guardó y el método no existe más.
--   * FALSO POSITIVO: un método `type='other'` llamado "Efectivo Mercado
--     Pago", ya borrado, queda 'cash'.
--
-- Ambos casos requieren id NULL o colgado **y** un nombre que miente. Es un
-- universo chico y sólo hacia atrás: desde esta migración el tipo viaja
-- siempre explícito y la heurística nunca más se aplica a una fila nueva.
-- Si aparece una diferencia de arqueo en una caja vieja, ESTE es el lugar
-- donde mirar.
--
-- `lower()` sin `unaccent`: la extensión no está instalada y las dos palabras
-- que buscamos no llevan tilde.
-- ─────────────────────────────────────────────────────────────────────────
UPDATE payment_transactions
   SET payment_method_type = CASE
         WHEN lower(payment_method_name) LIKE '%efectivo%'      THEN 'cash'::payment_method_type
         WHEN lower(payment_method_name) LIKE '%transferencia%' THEN 'transfer'::payment_method_type
         ELSE 'other'::payment_method_type
       END
 WHERE payment_method_type IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. NOT NULL. Después de las dos pasadas no puede quedar ninguna NULL: la 2b
--    tiene ELSE, así que cubre el resto del universo por construcción.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE payment_transactions
  ALTER COLUMN payment_method_type SET NOT NULL;

COMMENT ON COLUMN payment_transactions.payment_method_type IS
  'Snapshot del `payment_methods.type` al momento del cobro, hermano de '
  '`payment_method_name`. Es lo que el arqueo de caja usa para decidir qué '
  'entró al cajón (type = cash), en vez de buscar "efectivo" en el nombre. Se '
  'congela igual que el nombre porque el medio se puede renombrar o borrar y '
  'el comprobante histórico no puede cambiar. Lo escribe el backend en cada '
  'alta (ver resolvePaymentLineTypes en src/entries/entries.service.ts); no '
  'tiene DEFAULT a propósito, para que ningún cliente pueda insertar un tipo '
  'equivocado por omisión.';

-- ─────────────────────────────────────────────────────────────────────────
-- NOTA DE PROPAGACIÓN (leer antes de asumir que con esto alcanza)
--
-- Los UPDATE de arriba disparan `payment_transactions_before_update`, que
-- bumpea `sync_seq` (y `version`) de CADA fila tocada. Eso es deliberado: los
-- desktops se bajan la corrección sola en el próximo pull incremental, sin
-- resync completo. `version` también sube, y no rompe nada: las transacciones
-- no tienen un camino de update versionado propio (viajan adentro de la op de
-- `entry`, y la corrección borra y recrea).
--
-- PERO eso NO alcanza, y acá está la trampa. Secuencia real de deploy:
--
--   1. Se aplica esta migración -> sync_seq bumpeado en todas las filas.
--   2. El desktop, TODAVÍA con la versión vieja, hace un pull. Se baja las
--      filas, las escribe en Dexie con el mapper viejo (que no conoce
--      `paymentMethodType`) y AVANZA EL CURSOR.
--   3. Recién ahí se actualiza la app del desktop.
--
-- Resultado: copia local sin tipo y cursor ya pasado; el servidor no vuelve a
-- mencionar esas filas nunca más y el arqueo de ese operador se queda sin
-- efectivo. Por eso el upgrade de Dexie (front-desktop, v13) RESETEA los
-- cursores de `paymentTransactions:` y `paymentMethods:`. Una cosa sin la otra
-- deja el bug vivo en las máquinas que ya estaban andando.
-- ─────────────────────────────────────────────────────────────────────────
