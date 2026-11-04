# Plantillas personales de tablas

Las plantillas se sincronizan por usuario autenticado, plataforma (`web` o
`desktop`), contexto (estacionamiento o administración global) y tabla.
No son configuración compartida del estacionamiento. La vista actual y la
última plantilla seleccionada permanecen locales.

## API

- `GET /tenants/:tenantId/table-templates?platform=desktop&tableKey=history`
- `PUT /tenants/:tenantId/table-templates/:id`
- `DELETE /tenants/:tenantId/table-templates/:id`
- `POST /tenants/:tenantId/table-templates/import/:id`

Las mutaciones usan los mismos parámetros de consulta y un `mutationId` UUID.
Guardar/importar recibe `name`, `description?` y `config` versión 1.
Importar acepta además `createdAt?` y solo inserta identificadores ausentes.
Los endpoints equivalentes de `/admin/table-templates` exigen administrador.
El propietario siempre proviene del JWT, nunca del cuerpo ni de la consulta.

`user_table_templates` es un modelo GLOBAL de preferencias personales, con
`context_key` en lugar de `tenant_id`: también admite las tablas globales.
El contexto del estacionamiento se obtiene mediante `TenantInterceptor` y
`TenantMembershipGuard`. Todas las consultas incluyen propietario, plataforma,
contexto y tabla. RLS solo permite leer preferencias propias con acceso vigente
al contexto; las escrituras directas de los clientes están revocadas.

## Consistencia

La última mutación nueva aceptada por el servidor reemplaza la anterior,
aunque provenga de un equipo que estuvo sin conexión. Una transacción y un
cerrojo por propietario serializan escrituras. Los comprobantes de mutación
impiden que reintentar una respuesta perdida vuelva a aplicar una operación
antigua. La eliminación conserva una marca; importar no resucita esas filas.

Desktop lee Dexie y guarda cambios junto a la cola mediante `enqueuePendingOp`.
Solo la sesión del autor puede publicar una operación personal. Web conserva
una caché, pero confirma las escrituras en el servidor. Ambos refrescan al abrir
la tabla/el menú y recuperar el foco; también al reconectar. Desktop participa
en la sincronización manual. Descargar una plantilla no la aplica a la tabla.

## Pruebas y despliegue

Aplicar primero migración/backend y luego actualizar los clientes.
La suite habitual prueba validación y guards sin necesitar base.
Para probar SQL, RLS y concurrencia usar un PostgreSQL VACÍO Y DESCARTABLE:

```bash
TABLE_TEMPLATES_TEST_DATABASE_URL=postgresql://postgres:password@127.0.0.1:55437/parkit_templates_test bun test src/table-templates/table-templates.spec.ts
```

La prueba rechaza hosts externos y nombres de base ajenos a
`parkit_templates_test*`. Crea fixtures mínimos y aplica la migración nueva;
no sustituye el smoke de la cadena completa de migraciones Supabase.
