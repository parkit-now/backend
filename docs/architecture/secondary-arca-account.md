# Segunda cuenta ARCA

Cada estacionamiento admite una cuenta vigente por posicion (`primary` o
`secondary`). Los IDs son inmutables: reiniciar una vinculacion archiva el
borrador anterior. Las cuentas desvinculadas se conservan para las referencias
historicas. Los indices parciales SQL limitan las posiciones y evitan repetir
CUIT, entorno y punto de venta en un estacionamiento.

## Contrato

- `/tenants/:tenantId/arca/accounts`: listar y crear cuentas.
- `/tenants/:tenantId/arca/accounts/:accountId`: consultar, configurar y
  desvincular; los subrecursos `csr`, `certificate`, `reusable-certificates`,
  `reuse-certificate`, `sales-point` y `renewal/*` siguen el asistente existente.
- `/arca/account` y sus subrecursos se mantienen como alias de la primaria.
- Cobro, emision individual, lote, vista previa y consulta de receptor admiten
  `arcaAccountId`. Sin seleccion, las facturas nuevas usan primaria; los
  reintentos conservan el ID guardado. Solo el dueno puede usar secundaria.
- Una factura externa guarda `manualInvoiceArcaAccountId`,
  `manualInvoiceIssuerCuit` y `manualInvoiceIssuerName`. Las externas historicas
  sin emisor conocido no se atribuyen retrospectivamente.

Los modos de los medios de pago son compartidos. Desvincular secundaria no los
cambia; desvincular primaria quita ambas cuentas y desactiva esos modos.
Una emision incierta bloquea la desvinculacion de la cuenta afectada y el cambio
de emisor. Se mantienen los locks por movimiento y por CUIT/punto/tipo para
impedir comprobantes duplicados; el lifecycle de cuentas agrega un lock por
estacionamiento. El certificado, la condicion IVA y la alicuota son de la
cuenta elegida, no de la primaria.

## Desktop y desconexion

La cache de configuracion guarda solamente los DTOs publicos, nunca claves ni
certificados. Movimientos, pagos y facturas siguen leyendo desde Dexie. La
operacion de cobro encolada conserva el ID seleccionado; si la cuenta se
desvincula antes del sync, el cobro se conserva y la factura queda pendiente
con `ARCA_ACCOUNT_UNAVAILABLE`, sin cambiar a otro emisor.

## Despliegue

1. Aplicar `20261010163346_secondary_arca_account.sql` y desplegar el backend
   compatible antes de habilitar los clientes nuevos.
2. Desplegar web y desktop. Mobile solo actualiza los contratos; continua
   utilizando primaria.
3. No volver a un backend con el modelo de cuenta unica despues de crear una
   secundaria. Las versiones anteriores de los clientes siguen funcionando
   con los endpoints de primaria del backend nuevo.

La migracion asocia facturas anteriores solo si coincide su snapshot fiscal;
las pendientes sin emisor se vinculan a la primaria vigente. No modifica
comprobantes emitidos ni los datos de facturas externas existentes.

## Verificacion

Los tests de cuentas y facturas cubren limites, permisos, aislamiento, CUIT
compartido con distinto punto, desvinculacion, emision automatica, lotes,
facturas externas, cambios de emisor y reconciliacion. Los tests de desktop
ejercitan seleccion antes del cobro, persistencia en la cola offline y cache
sin conexion. Los de web verifican que cada movimiento nuevo vuelva a primaria
y que un emisor ausente nunca se sustituya silenciosamente.
