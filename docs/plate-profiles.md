# Fichas de vehículos por patente

`plate_profiles` es información operativa del estacionamiento, independiente de
`clients`/`client_plates` (facturación) y del catálogo `vehicles`. Su identidad
estable es `(tenant_id, plate)`; la patente normalizada no cambia por edición.

## API y permisos

- `GET /tenants/:tenantId/plate-profiles`: listado activo.
- `GET .../changes?afterSeq=0&limit=1000`: feed incremental con tombstones.
- `GET .../:plate`: ficha vigente, incluyendo borrado, para resolver conflictos.
- `POST ...`: alta o recreación; `PATCH .../:plate`: edición; `DELETE .../:plate`:
  olvido lógico. Requieren `mutationId` UUID, `occurredAt` (instante de la edición
  original, conservado offline) y `expectedVersion` (la
  `editVersion` de la ficha, 0 cuando todavía no hubo edición del dueño).

Los miembros pueden leer; solamente un membership `owner` puede administrar.
Ser administrador global sin membership de dueño no habilita las escrituras.
Guard/interceptor, cliente Prisma tenant-scoped y RLS refuerzan el aislamiento.
Las referencias a tipo/tarifa se validan dentro del tenant cuando cambian.

`version` y `syncSeq` avanzan con cualquier actualización. `editVersion` avanza
solo en operaciones del dueño, evitando falsos conflictos cuando se sincroniza
su propio ingreso offline antes de editar su ficha. Dos ediciones del dueño con
la misma versión no se pisan: la segunda recibe 409. Los recibos de mutación
evitan repetir escrituras ya confirmadas y no tienen acceso vía PostgREST.

## Aprendizaje

El trigger de entries aprende solo de ingresos confirmados y correcciones de
marca/modelo, tipo, color o tarifa de la visita más reciente. Compara
`(entered_at,id)`, no el orden de recepción. Notas, pagos, egresos y borrados de
estadías no actualizan los datos sugeridos. Al corregir se actualizan solo los
campos pertinentes, conservando otras ediciones del dueño.

Una ficha eliminada no se reconstruye por correcciones ni por relecturas del
historial. Solo un ingreso nuevo, posterior al olvido, puede recrearla. Un
ingreso sincronizado con fecha anterior a la última edición del dueño tampoco
la reemplaza. El backfill de la migración recorre todo el historial no eliminado
una única vez; no es un fallback permanente.

Las referencias anteriores y sus etiquetas se conservan aunque el catálogo
cambie. El desktop debe resolver cada campo contra sus opciones vigentes; si
no lo encuentra, no lo selecciona ni lo sustituye. No se almacenan precios.

## Despliegue y pruebas

Aplicar primero la migración `20261103130000_plate_profiles.sql` y desplegar el
backend; después distribuir desktop. No se requiere cambiar web ni mobile.

Las pruebas contractuales forman parte de `bun test`. Las pruebas PostgreSQL
requieren una base nueva, aislada y local llamada `parkit_plate_profiles_test`:

```sh
PLATE_PROFILES_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55439/parkit_plate_profiles_test bun test src/plate-profiles/plate-profiles.spec.ts
```

El fixture instala las dependencias mínimas y la migración real; no puede
ejecutarse sobre URLs externas ni reutilizar una base productiva.
