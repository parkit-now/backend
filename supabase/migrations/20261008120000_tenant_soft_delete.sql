-- Baja lógica de estacionamiento, con ventana de gracia y purga definitiva.
--
-- POR QUÉ
--
-- Borrar un estacionamiento era un `DELETE` físico sin transacción y sin una
-- sola guarda. Veintidós tablas cascadeaban bien, pero quedaba atrás todo lo
-- que no cuelga de una FK: las fotos de patentes en el bucket, la vinculación
-- de Mercado Pago (que se borraba sin llamar a `unlink()`), y la auditoría,
-- que por ser `ON DELETE SET NULL` no se borra sino que se ANONIMIZA — filas
-- con `tenant_id = NULL`, invisibles desde el panel y sin nada que diga de qué
-- estacionamiento eran. Peor que borrarlas.
--
-- A partir de acá el borrado es reversible por un plazo y después lo termina
-- un job (`TenantPurgeService`), que sí borra Storage, auditoría y filas en un
-- orden explícito.
--
-- QUÉ HACE
--
--   `deleted_at`      timestamptz NULL. NULL = vivo. Es el único campo que
--                     mira el resto del backend para decidir si existe.
--   `purge_after`     timestamptz NULL. Desde cuándo el job puede purgarlo.
--                     Separado de `deleted_at` porque la ventana de gracia es
--                     por borrado (`graceDays`, 0..365) y no una constante:
--                     un estacionamiento de prueba se purga con 0 y uno real
--                     con 30.
--   `deleted_by`      uuid NULL, FK a `users` ON DELETE SET NULL. Si el admin
--                     que borró se da de baja después, la baja del
--                     estacionamiento no se cae ni se borra en cascada.
--   `deletion_reason` text NULL. Lo que escribió el admin, para la auditoría.
--
-- COMPATIBILIDAD (expand/contract)
--
-- Las cuatro columnas son NULL y sin default: Postgres no reescribe la tabla y
-- un backend viejo las ignora por completo (sigue viendo todos los tenants,
-- que es el comportamiento de hoy). La FK va NOT VALID + VALIDATE aparte:
-- todas las filas son NULL, así que alcanza con un lock liviano.
--
-- `tenants` NO tiene triggers de sync (`sync_seq`/`version`): es una tabla
-- global, no tenant-local, así que este ALTER no genera tráfico de sync ni
-- invalida versiones cacheadas en ningún desktop offline.

ALTER TABLE tenants
    ADD COLUMN deleted_at      timestamptz,
    ADD COLUMN purge_after     timestamptz,
    ADD COLUMN deleted_by      uuid,
    ADD COLUMN deletion_reason text;

ALTER TABLE tenants
    ADD CONSTRAINT tenants_deleted_by_fkey
    FOREIGN KEY (deleted_by) REFERENCES users(id)
    ON DELETE SET NULL
    NOT VALID;

ALTER TABLE tenants VALIDATE CONSTRAINT tenants_deleted_by_fkey;

-- Los dos campos van juntos o no van: un `purge_after` sin `deleted_at` sería
-- un estacionamiento vivo con fecha de purga, y el job lo saltearía por
-- casualidad (filtra por `deleted_at IS NOT NULL`) en vez de por diseño.
ALTER TABLE tenants
    ADD CONSTRAINT tenants_deletion_fields_consistent
    CHECK (
        (deleted_at IS NULL AND purge_after IS NULL)
        OR (deleted_at IS NOT NULL AND purge_after IS NOT NULL)
    );

-- Índice parcial para el camino caliente: TODA lectura de tenant vivo lleva
-- `deleted_at IS NULL`. El parcial sólo indexa las filas vivas, que son
-- casi todas, pero le deja claro al planner que el filtro es selectivo.
CREATE INDEX tenants_live_idx ON tenants (id) WHERE deleted_at IS NULL;

-- Para el job de purga, que corre una vez por día y pregunta
-- `deleted_at IS NOT NULL AND purge_after <= now()`.
CREATE INDEX tenants_purge_idx ON tenants (purge_after) WHERE deleted_at IS NOT NULL;

COMMENT ON COLUMN tenants.deleted_at IS
  'Baja lógica. NULL = vivo. Un tenant con esto seteado desaparece de toda '
  'lectura menos las del admin global, que puede restaurarlo hasta la purga.';
COMMENT ON COLUMN tenants.purge_after IS
  'Desde cuándo TenantPurgeService puede borrarlo definitivamente (Storage, '
  'auditoría y filas). Se calcula al dar de baja, con los graceDays del pedido.';
COMMENT ON COLUMN tenants.deleted_by IS
  'Admin global que dio de baja. SET NULL si después se borra ese usuario.';
COMMENT ON COLUMN tenants.deletion_reason IS
  'Motivo que escribió el admin al dar de baja. Queda también en audit_log.';
