-- Los métodos de pago del sistema pasan a llamarse en español: 'Efectivo' y
-- 'Transferencia'.
--
-- POR QUÉ: EL ARQUEO DE CAJA NUNCA CONTÓ EL EFECTIVO
--
-- `bootstrap_tenant_defaults()` (20260901013345_tenant_bootstrap_trigger.sql)
-- sembraba el método con el nombre TÉCNICO, igual que el enum:
--
--     VALUES (NEW.id, 'transfer', 'transfer', ...),
--            (NEW.id, 'cash',     'cash',     ...);
--
-- Pero el cierre de caja del desktop decide qué es efectivo por el NOMBRE, no
-- por el tipo (front-desktop/src/features/entries/entryUtils.ts):
--
--     export function isCashMethod(name: string): boolean {
--       return name.toLowerCase().includes('efectivo');
--     }
--
-- `'cash'.includes('efectivo')` es false. O sea: el método de efectivo POR
-- DEFECTO nunca se contabilizó como efectivo. El bug se propaga a
-- `computeSessionSummary` (cash-session/cashSessionUtils.ts), a
-- `CloseCashSessionDialog` (`pm.isCash`) y a `CashSessionStats`: el esperado en
-- caja daba 0 y todo cobro en efectivo aparecía como "otros medios". Sólo se
-- salvaban los tenants cuyo dueño había renombrado el método a mano.
--
-- Arreglar `isCashMethod` para que mire `type` es el fix correcto de fondo y
-- queda pendiente, pero el nombre en español hay que ponerlo igual: es lo que
-- ve el usuario en pantalla, en el ticket y en el arqueo. Un método que dice
-- "cash" en una app en español es un default mal elegido, no una decisión.
--
-- QUÉ HACE ESTA MIGRACIÓN
--
--   1. CREATE OR REPLACE de la función completa, idéntica a la vigente salvo
--      los dos nombres. No se toca el trigger: sigue siendo el mismo
--      `on_tenant_created_bootstrap_defaults`, que apunta a esta función.
--   2. Backfill de `payment_methods` (los tenants ya existentes), SÓLO los que
--      conservan el nombre técnico original.
--   3. Backfill de `payment_transactions.payment_method_name`, que es el
--      SNAPSHOT del nombre al momento del cobro. Sin este paso el rename no
--      llega al arqueo: ver el bloque 3 al final del archivo.
--
-- NO SE TOCA `is_default`: hoy el default es 'transfer' y así queda. Cambiarlo
-- es otra decisión, con otro impacto en el flujo de cobro, y no es parte de
-- esta migración.
--
-- No hay cambio de esquema: es una función y datos. `prisma/schema/**` no se
-- toca y no hace falta `db:generate`.

-- 1. La función, completa. Único cambio respecto de la versión anterior: los
--    nombres de los dos métodos de pago del sistema (bloque 4).
CREATE OR REPLACE FUNCTION public.bootstrap_tenant_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- 1. Los siete tipos de vehículo, propios y editables.
    INSERT INTO vehicle_types (id, tenant_id, name, accepted)
    SELECT gen_random_uuid(), NEW.id, d.name, d.accepted
      FROM vehicle_type_defaults d
    ON CONFLICT DO NOTHING;

    -- 2. El catálogo, resolviendo el tipo por nombre contra los recién creados.
    --    Una sentencia, no 244 round-trips.
    INSERT INTO vehicles (id, tenant_id, brand, model, type_id)
    SELECT gen_random_uuid(), NEW.id, d.brand, d.model, vt.id
      FROM vehicle_catalog_defaults d
      JOIN vehicle_types vt
        ON vt.tenant_id = NEW.id
       AND vt.deleted_at IS NULL
       AND lower(btrim(vt.name)) = lower(btrim(d.type_name))
    ON CONFLICT DO NOTHING;

    -- 3. Servicios. Antes sólo los creaba applications.approve().
    INSERT INTO services (tenant_id, code, enabled)
    VALUES (NEW.id, 'ADVANCE_RESERVATION', false)
    ON CONFLICT (tenant_id, code) DO NOTHING;

    -- 4. Métodos de pago del sistema. Nombres en español, que es lo que ve el
    --    usuario: editables por el dueño, marcados is_system para que no se
    --    puedan borrar. El nombre importa además porque el arqueo del desktop
    --    detecta el efectivo por nombre (isCashMethod).
    INSERT INTO payment_methods (tenant_id, type, name, enabled, is_system, is_default)
    VALUES (NEW.id, 'transfer', 'Transferencia', true, true, true),
           (NEW.id, 'cash',     'Efectivo',      true, true, false)
    ON CONFLICT DO NOTHING;

    RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.bootstrap_tenant_defaults() IS
  'AFTER INSERT ON tenants: siembra los defaults de todo estacionamiento nuevo '
  '(tipos de vehículo, catálogo de modelos, servicios y los métodos de pago del '
  'sistema "Efectivo" y "Transferencia"). Agregar un default nuevo se hace acá '
  'y en ningún otro lado: los tres caminos de alta de tenants convergen en este '
  'trigger.';

-- 2. Backfill de `payment_methods` en los tenants existentes.
--
--    El `name = '...'` del WHERE es deliberado y NO es redundante con el
--    `type`: si un dueño ya renombró su método a mano ("Efectivo caja chica",
--    "Transferencia Galicia", lo que sea), esa fila no se toca. No se le pisa
--    una decisión al usuario para uniformar un default.
--
--    Idempotente: re-correrla no encuentra filas y no hace nada.
--
--    El UPDATE dispara `payment_methods_before_update`, que bumpea `sync_seq`,
--    `version` y `updated_at` (20260604130000_payment_methods_sync.sql). Es lo
--    que queremos: el desktop se lleva el rename en el próximo
--    pullChanges(afterSeq) sin tener que resincronizar todo.
UPDATE payment_methods
   SET name = 'Efectivo'
 WHERE is_system
   AND type = 'cash'
   AND name = 'cash';

UPDATE payment_methods
   SET name = 'Transferencia'
 WHERE is_system
   AND type = 'transfer'
   AND name = 'transfer';

-- 3. Backfill del SNAPSHOT: `payment_transactions.payment_method_name`.
--
--    SIN ESTE BLOQUE EL RENAME NO LLEGA AL ARQUEO. El cierre de caja NO lee
--    `payment_methods`: lee esta columna desnormalizada, que se copia del
--    método al momento de cobrar y después no se vuelve a mirar.
--
--        front-desktop/src/features/entries/ExitModal.tsx
--            paymentMethodName: pm.name            ← se COPIA al cobrar
--        front-desktop/src/features/cash-session/cashSessionUtils.ts
--            isCash: isCashMethod(tx.paymentMethodName)   ← lee la COPIA
--
--    O sea: renombrar sólo `payment_methods` arregla los cobros FUTUROS y deja
--    todo lo ya cobrado en efectivo contado como "otros medios". Medido sobre
--    una transacción de $300: con `'Efectivo'` el esperado en caja da $3.800,
--    con `'cash'` da $3.500 y la transacción suma +$0,00. Son $300 de efectivo
--    real que desaparecen del arqueo. Peor todavía: cualquier caja ABIERTA en
--    el momento del deploy cerraría con los dos criterios mezclados.
--
--    POR QUÉ SE PUEDE TOCAR UN SNAPSHOT HISTÓRICO. Un snapshot existe para
--    congelar una DECISIÓN del usuario ("cobré con Efectivo caja chica"), y
--    eso se respeta: el `WHERE name = 'cash'` deja intacta cualquier fila
--    cobrada con un método renombrado a mano. `'cash'`/`'transfer'` no los
--    eligió nadie: son el valor del enum `payment_method_type` que se filtró a
--    una columna de DISPLAY por el default del trigger. Corregirlos restaura
--    la intención original, no reescribe historia. La alternativa —dejarlos—
--    es que el arqueo de esos cobros quede mal para siempre.
--
--    NO se filtra por `deleted_at`: una transacción anulada (soft-delete,
--    20260908090000) puede restaurarse, y si se la deja con el nombre viejo
--    vuelve con el arqueo roto. Corregirla igual es más barato que acordarse.
--
--    EFECTO BUSCADO, NO COLATERAL: este UPDATE dispara
--    `payment_transactions_before_update` (20260609120000_add_cash_sessions.sql),
--    que bumpea `sync_seq`, `version` y `updated_at`. Es exactamente lo que
--    queremos: cada desktop se lleva la corrección sola en el próximo
--    `pullChanges(afterSeq)` y recalcula su arqueo, sin resync completo ni
--    intervención manual. El costo es que las filas tocadas viajan una vez
--    más por el sync incremental; a cambio no queda ningún cliente contando
--    distinto que el servidor.
--
--    Idempotente: re-correrla no encuentra filas y no bumpea nada.
UPDATE payment_transactions
   SET payment_method_name = 'Efectivo'
 WHERE payment_method_name = 'cash';

UPDATE payment_transactions
   SET payment_method_name = 'Transferencia'
 WHERE payment_method_name = 'transfer';
