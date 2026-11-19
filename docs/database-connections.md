# Conexiones de base de datos

El backend comparte un `PrismaService` singleton y un pool de `pg` por proceso.
Con Prisma 7 y `@prisma/adapter-pg`, los limites se configuran en el driver;
agregar `connection_limit` a la URL no reemplaza esta configuracion.

| Variable                           | Valor por defecto | Alcance                                |
| ---------------------------------- | ----------------- | -------------------------------------- |
| `DATABASE_POOL_MAX`                | 3                 | Conexiones simultaneas por proceso     |
| `DATABASE_POOL_CONNECT_TIMEOUT_MS` | 5000              | Espera para obtener/abrir una conexion |
| `DATABASE_POOL_IDLE_TIMEOUT_MS`    | 10000             | Liberacion de conexiones ociosas       |

Los valores deben ser enteros positivos; una configuracion invalida impide el
arranque. No son limites de duracion de consultas ni cambian el aislamiento
tenant, los precios, las transacciones o las politicas RLS. El pool pone en cola
el exceso de solicitudes hasta que haya una conexion libre o venza la espera.
El limite de adquisicion tampoco sustituye el `maxWait` de una transaccion Prisma.

## Presupuesto de conexiones

El maximo es POR PROCESO. Calcular instancias simultaneas por limite del pool,
incluyendo revisiones que se solapen durante despliegues, otros servicios y
herramientas que utilicen la misma base/rol. Con tres procesos y el valor inicial
de 3 se utilizan como maximo 9 conexiones; esto deja margen dentro de un pool de
15, pero no garantiza disponibilidad si otros clientes consumen ese margen.
Reducir el pool puede aumentar la espera en picos; validar latencias y errores
en staging antes de aumentar trafico o desplegar. No subir el limite de
instancias o de conexiones sin revisar el presupuesto completo.

Supabase session mode (puerto 5432 del host pooler) reserva una conexion por
cliente. Transaction mode (6543) puede servir para clientes con mas concurrencia,
pero cambiar el puerto es una decision de despliegue: verificar compatibilidad
de transacciones, SQL dependiente de sesion y prepared statements primero.
El codigo no reescribe `DATABASE_URL` ni usa `DIRECT_URL` para operar.

## Observabilidad y cierre

El arranque registra solo limites y tiempos del pool, sin URLs ni credenciales.
Las conexiones usan `application_name=parkit-backend:<K_REVISION>` cuando existe
esa variable de Cloud Run, para distinguirlas en `pg_stat_activity`.
Un error de conexion ociosa registra contadores de conexiones totales, ociosas
y solicitudes en espera. `SIGTERM` activa los hooks de Nest y cierra Prisma y
su pool externo; esto evita depender solo del cierre forzado del contenedor.

## Incidente del 19 de noviembre de 2026

Los logs de Cloud Run mostraron `EMAXCONNSESSION`, con limite de 15 clientes,
y respuestas 500 en GET de reservas entre 11:05 y 11:07 (Argentina).
La configuracion desplegada usaba el pooler de Supabase por el puerto 5432;
el codigo dejaba `pg.Pool` con su maximo predeterminado de 10 por proceso.
No se identificaron retrospectivamente todos los consumidores de conexiones.
Este fallo es distinto del rechazo de una deteccion LPR por referenciar una
estadia todavia no sincronizada; esa correccion corresponde al desktop.

La correccion no requiere migraciones ni modificaciones de datos. Publicar una
nueva revision por el flujo habitual y observar errores de conexion y latencias.
Para volver a un limite anterior se puede configurar `DATABASE_POOL_MAX=10`,
si el presupuesto lo permite, o volver a la revision anterior. No borrar colas
locales ni reintentar cobros como parte de este cambio.

Fuentes: [pg Pool](https://node-postgres.com/apis/pool),
[limites de Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits).
