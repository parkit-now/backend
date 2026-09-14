-- Suma `mercadopago_qr` al enum `payment_method_type`.
--
-- El cobro con QR de Mercado Pago es un medio de pago más desde el punto de
-- vista del arqueo, pero no es ninguno de los tres que había: no es `cash`
-- (la plata no queda en el cajón), no es `transfer` (no la carga una persona a
-- mano, la confirma un webhook) y no puede ser `other` (el arqueo necesita
-- distinguirlo para no mezclarlo con "Tarjeta de débito"). Necesita valor
-- propio.
--
-- POR QUÉ `ADD VALUE` Y NO EL RENAME+RECREATE QUE HAY EN ESTE REPO
--
-- Acá hay tres precedentes del patrón "renombrar el tipo viejo, crear el nuevo,
-- convertir la columna, borrar el viejo": `20260601212225_roles_v2.sql`,
-- `20260831190000_vehicles_type_enum_v2.sql` y
-- `20260901012826_capacity_total_and_service_code_v2.sql`. Esta migración NO
-- los sigue, y es a propósito.
--
-- Esos tres CAMBIABAN o QUITABAN valores. Postgres no te deja hacer eso sobre
-- un enum vivo, así que el rename+recreate no era una preferencia de estilo:
-- era la única forma. Nosotros AGREGAMOS uno, que es el caso que Postgres sí
-- soporta nativo.
--
-- La diferencia no es cosmética, es de costo:
--
--   * El rename+recreate obliga a un `ALTER TABLE ... ALTER COLUMN ... TYPE
--     ... USING`, que toma `ACCESS EXCLUSIVE` sobre la tabla (bloquea hasta
--     los SELECT) y REESCRIBE LA TABLA ENTERA, fila por fila.
--   * Una de las tablas que usan este enum es `payment_transactions`, que
--     tiene una fila por cobro de cada playa y crece para siempre. Reescribirla
--     entera para agregar una constante es pagar un costo que crece con el
--     éxito del producto, cada vez que se agregue un medio de pago.
--   * `ALTER TYPE ... ADD VALUE` es O(1): toca el catálogo (`pg_enum`) y nada
--     más. No bloquea lecturas, no toca datos.
--
-- `IF NOT EXISTS` acá SÍ corresponde: no estamos creando un objeto nuevo (para
-- eso la convención del repo es sin `IF NOT EXISTS`), estamos modificando uno
-- preexistente, y sin el guard esta migración no es re-ejecutable.
--
-- LA TRAMPA DE POSTGRES, Y POR QUÉ ESTO VA EN UN SOLO ARCHIVO
--
-- Un valor agregado con `ADD VALUE` no se puede USAR en la misma transacción
-- que lo agregó, y las migraciones de Supabase corren un archivo por
-- transacción. O sea: si alguna migración de este mismo archivo escribiera el
-- literal `'mercadopago_qr'`, habría que partirlo en dos archivos.
--
-- Se verificó, no se asumió: ninguna migración usa el literal, porque el medio
-- de pago de una playa se crea EN RUNTIME cuando el dueño vincula su cuenta de
-- Mercado Pago (B5), no por migración ni por el trigger
-- `bootstrap_tenant_defaults()` — una playa sin Mercado Pago vinculado no tiene
-- por qué mostrar ese medio de pago en la pantalla de cobro. Tampoco lo usa
-- `supabase/seed.sql`. Con eso, un solo archivo alcanza y no hay nada que
-- partir.
--
-- Para el que agregue el siguiente valor: si tu migración además INSERTA o
-- ACTUALIZA filas con el literal nuevo, separalo en dos archivos (uno que
-- agrega el valor, otro que lo usa). El error es `unsafe use of new value of
-- enum type`, y aparece recién al correr, no al escribir.

ALTER TYPE payment_method_type ADD VALUE IF NOT EXISTS 'mercadopago_qr';

COMMENT ON TYPE payment_method_type IS
  'Qué ES un medio de pago, independiente de cómo lo haya llamado el dueño. '
  'El arqueo de caja decide por acá y nunca por el nombre. `cash` = plata en '
  'el cajón; `transfer` = transferencia bancaria cargada a mano; '
  '`mercadopago_qr` = cobro con el QR de Mercado Pago, confirmado por webhook; '
  '`other` = cualquier medio propio que cargue el dueño.';
