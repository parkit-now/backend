-- El método de pago por defecto de toda playa nueva pasa a ser "Efectivo".
--
-- POR QUÉ
--
-- `bootstrap_tenant_defaults()` venía sembrando 'transfer' con `is_default`,
-- así que el modal de egreso del desktop arrancaba con "Transferencia"
-- preseleccionada en cada estacionamiento nuevo. En una playa lo que más entra
-- es efectivo: el operador tenía que corregir la selección en la mayoría de los
-- cobros, y un default que se corrige casi siempre no es un default, es un paso
-- extra y una fuente de cobros mal tipeados a la hora pico.
--
-- No es cosmético: `payment_transactions.payment_method_type` es un SNAPSHOT
-- (20260913200901) y el arqueo de caja decide por ahí qué plata está en el
-- cajón. Un cobro en efectivo que se guarda como 'transfer' porque nadie tocó
-- el selector le rompe el cierre al que está de turno.
--
-- QUÉ HACE
--
--   1. `CREATE OR REPLACE` de la función COMPLETA, con el `is_default` dado
--      vuelta. Los otros tres bloques —los siete tipos de vehículo, el catálogo
--      de modelos y el servicio de reserva anticipada— van copiados tal cual:
--      un `CREATE OR REPLACE` reemplaza el cuerpo entero, no lo parchea.
--   2. Backfill de los tenants que YA existen, sólo los que conservan la
--      configuración original.
--
-- No hay cambio de esquema: es una función y datos. `prisma/schema/**` no se
-- toca y no hace falta `db:generate`.

-- 1. La función, completa. Único cambio respecto de la versión vigente
--    (20260913163737): los dos `is_default` del bloque 4.
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
    --    puedan borrar.
    --
    --    `is_default` va en EFECTIVO. Es con lo que arranca el modal de egreso
    --    y es lo que más se cobra en una playa; el dueño lo puede mover cuando
    --    quiera desde su panel.
    INSERT INTO payment_methods (tenant_id, type, name, enabled, is_system, is_default)
    VALUES (NEW.id, 'transfer', 'Transferencia', true, true, false),
           (NEW.id, 'cash',     'Efectivo',      true, true, true)
    ON CONFLICT DO NOTHING;

    RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.bootstrap_tenant_defaults() IS
  'AFTER INSERT ON tenants: siembra los defaults de todo estacionamiento nuevo '
  '(tipos de vehículo, catálogo de modelos, servicios y los métodos de pago del '
  'sistema "Efectivo" —el preseleccionado— y "Transferencia"). Agregar un '
  'default nuevo se hace acá y en ningún otro lado: los tres caminos de alta de '
  'tenants convergen en este trigger.';

-- 2. Backfill de los tenants existentes.
--
--    SÓLO LOS QUE NUNCA TOCARON ESTO. Mismo criterio que el backfill del rename
--    (20260913163737): el default es una decisión del dueño, y si ya la tomó no
--    se la uniforma. Un tenant entra al backfill únicamente si sigue exactamente
--    como lo dejó el trigger:
--
--      a) su 'transfer' del sistema tiene is_default,
--      b) su 'cash' del sistema NO lo tiene,
--      c) ninguna otra fila suya tiene is_default, y
--      d) nadie movió nunca el default de ese tenant desde el panel.
--
--    (d) ES EL QUE HACE FALTA DE VERDAD, y por qué no alcanza con el estado.
--    "Transferencia es el default" es EXACTAMENTE la misma fila para un tenant
--    que nunca abrió la pantalla y para un dueño que entró, miró y eligió
--    transferencia a propósito. Mirando sólo `payment_methods` son
--    indistinguibles, y pisarle el segundo caso es justo lo que esta migración
--    promete no hacer. Lo que sí los distingue es el rastro:
--    `EntitiesService.togglePaymentMethod` audita cada cambio como
--    'payment_method.toggled' con `isDefault` en el metadata
--    (src/entities/entities.service.ts). Si ese registro existe, hubo una
--    decisión y no se toca.
--
--    Su límite, explícito: un UPDATE a mano contra la base no deja rastro en
--    `audit_log`, así que para ese caso el estado vuelve a ser todo lo que hay.
--    Es aceptable — nadie opera la producción por SQL suelto— y es preferible a
--    no distinguir nada. Si el nombre de la acción auditada cambia, este NOT
--    EXISTS deja de proteger en silencio: está atado desde
--    `src/entities/system-payment-methods.spec.ts`.
--
--    (c) parece redundante y no lo es. La regla "un solo default por entidad"
--    NO existe en la base: no hay unique index ni constraint sobre `is_default`
--    (ver `\d payment_methods`: el único índice único es
--    `payment_methods_tenant_system_type_idx`, sobre (tenant_id, type) WHERE
--    is_system). La invariante la sostiene la aplicación, en
--    `EntitiesService.togglePaymentMethod` (src/entities/entities.service.ts),
--    que dentro de una transacción apaga el default anterior antes de prender el
--    nuevo. Cualquier escritura que no pase por ahí puede dejar dos defaults, y
--    en ese caso (a) y (b) solos no alcanzarían para saber si el dueño eligió
--    algo: si marcó su "Tarjeta de débito" como default y la fila de transfer
--    quedó prendida, pisarlo sería exactamente lo que esta migración promete no
--    hacer. DEUDA ANOTADA: falta
--    `CREATE UNIQUE INDEX ... ON payment_methods (tenant_id) WHERE is_default`.
--    No se agrega acá porque primero hay que limpiar los tenants que hoy puedan
--    violarla, y eso es un cambio con su propio riesgo.
--
--    UNA SOLA SENTENCIA, no dos. Hoy da lo mismo para la integridad —sin índice
--    único no hay estado intermedio inválido posible—, pero dos sentencias
--    tendrían un problema real: la condición (a)/(b)/(c) deja de cumplirse en
--    cuanto la primera corre, así que la segunda ya no podría recalcular el
--    mismo conjunto de tenants. Con un solo UPDATE el CTE se evalúa una vez. Si
--    algún día se agrega el índice único parcial, ojo: un unique index se chequea
--    por fila, no al final de la sentencia, así que habría que hacerlo
--    DEFERRABLE o pasar a dos sentencias apagando primero.
--
--    IDEMPOTENTE: re-correrla no encuentra tenants (ya ninguno cumple (a)) y no
--    escribe nada. El `pm.is_default IS DISTINCT FROM (pm.type = 'cash')` del
--    final lo garantiza sin depender de eso: ninguna fila se escribe con el
--    valor que ya tiene.
--
--    EL CHURN DE SYNC ACÁ ES BUSCADO. El UPDATE dispara
--    `payment_methods_before_update` (20260604130000), que bumpea `sync_seq`,
--    `version` y `updated_at`. Es lo que queremos: cada desktop se baja el
--    default nuevo en su próximo `pullChanges(afterSeq)`, sin resync completo.
--    Por eso importa tocar sólo las filas que de verdad cambian: dos por tenant
--    migrado y ninguna más.
WITH configuracion_original AS (
    SELECT t.id AS tenant_id
      FROM tenants t
     WHERE EXISTS (
               SELECT 1 FROM payment_methods pm
                WHERE pm.tenant_id = t.id
                  AND pm.is_system
                  AND pm.type = 'transfer'
                  AND pm.is_default
           )
       AND EXISTS (
               SELECT 1 FROM payment_methods pm
                WHERE pm.tenant_id = t.id
                  AND pm.is_system
                  AND pm.type = 'cash'
                  AND NOT pm.is_default
           )
       AND NOT EXISTS (
               SELECT 1 FROM payment_methods pm
                WHERE pm.tenant_id = t.id
                  AND pm.is_default
                  AND NOT (pm.is_system AND pm.type = 'transfer')
           )
       AND NOT EXISTS (
               SELECT 1 FROM audit_log a
                WHERE a.tenant_id = t.id
                  AND a.action = 'payment_method.toggled'
                  AND a.metadata ->> 'isDefault' IS NOT NULL
           )
)
UPDATE payment_methods pm
   SET is_default = (pm.type = 'cash')
  FROM configuracion_original o
 WHERE pm.tenant_id = o.tenant_id
   AND pm.is_system
   AND pm.type IN ('transfer', 'cash')
   AND pm.is_default IS DISTINCT FROM (pm.type = 'cash');
