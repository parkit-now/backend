-- Dirección estructurada del tenant (prerequisito del cobro con QR de Mercado Pago).
--
-- Para dar de alta un `Store` en Mercado Pago hay que mandar la ubicación con
-- los campos SEPARADOS (`street_name`, `street_number`, `city_name`,
-- `state_name`, `latitude`, `longitude`). Hoy `tenants.address` es un `text`
-- libre del tipo 'Av. Corrientes 1234, CABA': sirve para mostrarlo en pantalla
-- y para nada más. Mercado Pago avisa explícitamente que una ubicación mal
-- cargada le rompe el cálculo de impuestos al dueño del comercio, así que esto
-- no es cosmético: es plata del dueño.
--
-- Decisiones y el porqué de cada una:
--
-- 1. TODAS NULLABLE. Un tenant no necesita dirección estructurada para existir
--    (lo demuestran las tres vías de alta: aprobación de solicitud, alta
--    directa del admin y seed). La obligatoriedad aparece recién al vincular
--    Mercado Pago, y ahí la valida el service con un error de dominio
--    entendible. Ponerlas NOT NULL rompería en el acto todas las filas que ya
--    existen y convertiría el alta de un estacionamiento en un formulario de
--    ocho campos obligatorios.
--
-- 2. `street_number` ES text, NO int. La numeración argentina real incluye
--    'S/N' (sin número), '1234 bis', 'Km 5' y similares. Un `integer` obliga a
--    mentir o a dejar el campo vacío, y Mercado Pago recibe el campo como
--    string igual. Esto está además documentado en el COMMENT de la columna
--    para que nadie lo "arregle" más adelante.
--
-- 3. `address` SE CONSERVA tal cual. Pasa a guardar la `nomenclatura` que
--    devuelve la API Georef del Estado argentino: es el string de display
--    (listados, buscador del panel admin, `entity-summary`) y mantiene la
--    retrocompatibilidad con los clientes que hoy leen `address`. No se
--    duplica información: los campos nuevos son los datos, `address` es cómo
--    se muestran.
--
-- 4. NO HAY BACKFILL. Parsear direcciones libres en SQL es adivinar; una
--    dirección mal adivinada es peor que una vacía, justamente por el tema de
--    impuestos del punto 0. Las filas viejas quedan con los campos nuevos en
--    NULL y se completan cuando el dueño edite el perfil (el front normaliza
--    contra Georef y manda los campos ya separados).
--
-- 5. VAN A COLUMNAS PLANAS, NO A `settings` (el jsonb). `settings` se escribe
--    hoy con literales del tipo `{ capacity }` que pisan el objeto entero, y
--    una dirección perdida en silencio es exactamente el modo de falla que no
--    queremos acá. Columnas planas además permiten CHECKs (los de acá abajo),
--    índices y un contrato tipado en Prisma.
--
-- 6. EL BACKEND NO GEOCODIFICA. No llama a Georef ni a ningún geocoder: sólo
--    guarda lo que le mandan ya normalizado. `geocoding_source` deja asentado
--    quién produjo el dato ('georef' = normalizado por la API del Estado,
--    'manual' = lo escribió una persona a mano) y `geocoded_at` cuándo, para
--    poder re-normalizar más adelante sin pisar lo cargado a mano.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS street_name      text,
  ADD COLUMN IF NOT EXISTS street_number    text,
  ADD COLUMN IF NOT EXISTS floor            text,
  ADD COLUMN IF NOT EXISTS city_name        text,
  ADD COLUMN IF NOT EXISTS state_name       text,
  ADD COLUMN IF NOT EXISTS postal_code      text,
  ADD COLUMN IF NOT EXISTS latitude         numeric(9,6),
  ADD COLUMN IF NOT EXISTS longitude        numeric(9,6),
  ADD COLUMN IF NOT EXISTS geocoding_source varchar(16),
  ADD COLUMN IF NOT EXISTS geocoded_at      timestamptz;

-- Un punto es (lat, lng) o NADA. Media coordenada es peor que ninguna: parece
-- dato cargado, pasa cualquier chequeo de "¿tiene latitud?" y ubica al
-- comercio en el medio del océano. `num_nonnulls` cuenta los no-nulos: 0
-- (sin coordenadas) y 2 (par completo) valen; 1 no.
ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_coordinates_paired;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_coordinates_paired
  CHECK (num_nonnulls(latitude, longitude) <> 1);

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_latitude_range;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_latitude_range
  CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90);

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_longitude_range;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_longitude_range
  CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);

-- Conjunto cerrado en vez de texto libre: el origen del dato decide si se
-- puede re-normalizar automáticamente o si hay que respetar lo que cargó una
-- persona. Un valor nuevo es un cambio de comportamiento, así que pasa por
-- migración.
ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_geocoding_source_valid;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_geocoding_source_valid
  CHECK (geocoding_source IS NULL OR geocoding_source IN ('georef', 'manual'));

COMMENT ON COLUMN tenants.address IS
  'Dirección completa para mostrar, en una línea. Desde la dirección '
  'estructurada guarda la `nomenclatura` que devuelve la API Georef. Es el '
  'campo de display y el que mantiene la retrocompatibilidad con los clientes '
  'viejos; los datos para Mercado Pago viven en las columnas separadas.';

COMMENT ON COLUMN tenants.street_name IS
  'Nombre de la calle, sin altura. Va tal cual a `street_name` del Store de '
  'Mercado Pago.';

COMMENT ON COLUMN tenants.street_number IS
  'Altura de la calle, como TEXTO y no como entero a propósito: la numeración '
  'real incluye "S/N", "1234 bis" y "Km 5". Mercado Pago también lo recibe '
  'como string. No convertir a integer.';

COMMENT ON COLUMN tenants.floor IS
  'Piso y/o departamento (ej. "PB", "3 B"). Sólo para contacto/facturación: '
  'Mercado Pago no lo usa en la ubicación del Store.';

COMMENT ON COLUMN tenants.city_name IS
  'Localidad. Va a `city_name` del Store de Mercado Pago.';

COMMENT ON COLUMN tenants.state_name IS
  'Provincia (o CABA). Va a `state_name` del Store de Mercado Pago.';

COMMENT ON COLUMN tenants.postal_code IS
  'Código postal. No lo pide el Store de Mercado Pago; se guarda para '
  'facturación y para desambiguar localidades homónimas.';

COMMENT ON COLUMN tenants.latitude IS
  'Latitud en grados decimales, numeric(9,6) (~10 cm de resolución). Sólo '
  'válida junto con `longitude`: el CHECK `tenants_coordinates_paired` '
  'prohíbe media coordenada.';

COMMENT ON COLUMN tenants.longitude IS
  'Longitud en grados decimales, numeric(9,6). Sólo válida junto con '
  '`latitude` (CHECK `tenants_coordinates_paired`).';

COMMENT ON COLUMN tenants.geocoding_source IS
  'Quién produjo la dirección estructurada: `georef` (normalizada por la API '
  'Georef del Estado argentino) o `manual` (cargada a mano). Decide si se '
  'puede re-normalizar automáticamente sin pisar trabajo humano. El backend '
  'no geocodifica: sólo persiste lo que le mandan ya normalizado.';

COMMENT ON COLUMN tenants.geocoded_at IS
  'Cuándo se normalizó/cargó la dirección estructurada. Permite detectar '
  'datos viejos y re-normalizarlos.';
