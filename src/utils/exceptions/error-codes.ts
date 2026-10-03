/**
 * Catalog of stable Parkit API error codes.
 *
 * Each code identifies an error case uniquely and independently of the wording
 * of the `detail` field. Clients (web/desktop/mobile) keep a dictionary
 * `code -> message in the user's language` and look up by this value.
 *
 * Rules:
 *  - SCREAMING_SNAKE_CASE.
 *  - Domain prefix when it helps disambiguate (AUTH_, DB_).
 *  - NEVER rename an already-published code. If the semantics change, add a new
 *    one and deprecate the old.
 *  - For field-level validation errors the class-validator constraint name
 *    (camelCase) is used as the code: `isEmail`, `minLength`, etc. — it stays
 *    stable because it comes from the library.
 */
export const ErrorCodes = {
  // Auth
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_REFRESH_INVALID: 'AUTH_REFRESH_INVALID',
  AUTH_MISSING_TOKEN: 'AUTH_MISSING_TOKEN',
  AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
  AUTH_USER_NOT_PROVISIONED: 'AUTH_USER_NOT_PROVISIONED',
  AUTH_EMAIL_ALREADY_EXISTS: 'AUTH_EMAIL_ALREADY_EXISTS',
  AUTH_WEAK_PASSWORD: 'AUTH_WEAK_PASSWORD',
  AUTH_REGISTER_FAILED: 'AUTH_REGISTER_FAILED',
  AUTH_LOGOUT_FAILED: 'AUTH_LOGOUT_FAILED',
  AUTH_RESET_TOKEN_INVALID: 'AUTH_RESET_TOKEN_INVALID',
  AUTH_RESET_PASSWORD_FAILED: 'AUTH_RESET_PASSWORD_FAILED',

  // Onboarding (parking-lot applications)
  ONBOARDING_INVALID_STATE: 'ONBOARDING_INVALID_STATE',
  ONBOARDING_APPLICATION_NOT_FOUND: 'ONBOARDING_APPLICATION_NOT_FOUND',
  ONBOARDING_NOT_SUBMITTABLE: 'ONBOARDING_NOT_SUBMITTABLE',
  ONBOARDING_DOCUMENT_NOT_FOUND: 'ONBOARDING_DOCUMENT_NOT_FOUND',

  // Storage (Supabase object storage)
  STORAGE_SIGNED_URL_FAILED: 'STORAGE_SIGNED_URL_FAILED',
  STORAGE_UPLOAD_FAILED: 'STORAGE_UPLOAD_FAILED',
  STORAGE_REMOVE_FAILED: 'STORAGE_REMOVE_FAILED',

  // Admin · parkings (tenants managed from the Ops panel)
  PARKING_NOT_FOUND: 'PARKING_NOT_FOUND',

  // Admin · users
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_DELETE_FAILED: 'USER_DELETE_FAILED',
  MEMBERSHIP_ALREADY_EXISTS: 'MEMBERSHIP_ALREADY_EXISTS',
  MEMBERSHIP_NOT_FOUND: 'MEMBERSHIP_NOT_FOUND',

  // Staff (ABM de empleados hecho por el dueño de la playa).
  // Estos dos hablan del TARGET de la operación, no del caller: por eso no
  // sirven `ENTITY_NO_ACCESS` ni `ENTITY_INSUFFICIENT_ROLE`, que significan
  // "vos no podés" cuando acá el caller tiene permisos de sobra.
  //
  // El caller apuntó a su propio userId. Ni PATCH ni DELETE sobre uno mismo:
  // evita que alguien se auto-degrade o se auto-borre y pierda el acceso.
  STAFF_SELF_MANAGEMENT: 'STAFF_SELF_MANAGEMENT',
  // La operación dejaría al estacionamiento sin ningún owner (degradar, mover
  // o borrar al último). Siempre tiene que quedar al menos un dueño.
  STAFF_LAST_OWNER: 'STAFF_LAST_OWNER',

  // Entity (tenant)
  ENTITY_NOT_FOUND: 'ENTITY_NOT_FOUND',
  ENTITY_NOT_OWNER: 'ENTITY_NOT_OWNER',
  ENTITY_NOT_ACTIVE: 'ENTITY_NOT_ACTIVE',
  // Caller authenticated but has no membership in the target tenant.
  ENTITY_NO_ACCESS: 'ENTITY_NO_ACCESS',
  // Caller is a member (e.g. operator) but lacks the required entity role
  // (e.g. owner) for an owner-only action.
  ENTITY_INSUFFICIENT_ROLE: 'ENTITY_INSUFFICIENT_ROLE',

  // Vehicles
  VEHICLE_NOT_FOUND: 'VEHICLE_NOT_FOUND',
  // Ya existe otra entrada viva con la misma marca/modelo en el catálogo de
  // este estacionamiento.
  VEHICLE_DUPLICATE: 'VEHICLE_DUPLICATE',

  // Vehicle types (ABM por estacionamiento)
  VEHICLE_TYPE_NOT_FOUND: 'VEHICLE_TYPE_NOT_FOUND',
  // Ya existe otro tipo vivo con el mismo nombre en este estacionamiento
  // (comparación case-insensitive y sin espacios sobrantes).
  VEHICLE_TYPE_DUPLICATE: 'VEHICLE_TYPE_DUPLICATE',
  // Se intentó borrar un tipo que todavía tienen vehículos vivos, sin indicar
  // a qué tipo moverlos. El cliente debe reintentar con `reassignToTypeId`.
  VEHICLE_TYPE_IN_USE: 'VEHICLE_TYPE_IN_USE',
  // El tipo destino de la reasignación no existe, está borrado, o es el mismo
  // que se está borrando.
  VEHICLE_TYPE_REASSIGN_TARGET_INVALID: 'VEHICLE_TYPE_REASSIGN_TARGET_INVALID',

  // Payment methods
  PAYMENT_METHOD_NOT_FOUND: 'PAYMENT_METHOD_NOT_FOUND',
  PAYMENT_METHOD_SYSTEM_LOCKED: 'PAYMENT_METHOD_SYSTEM_LOCKED',
  // Se intento HABILITAR un medio que vive de una integracion externa
  // (hoy solo `mercadopago_qr`) sin que esa integracion este vinculada y viva
  // (409). Deshabilitarlo o renombrarlo sigue permitido siempre: lo unico que
  // se bloquea es prender un boton de cobro que no puede cobrar.
  PAYMENT_METHOD_INTEGRATION_NOT_LINKED:
    'PAYMENT_METHOD_INTEGRATION_NOT_LINKED',

  // Entries (vehicle stays)
  ENTRY_DUPLICATE_ACTIVE_STAY: 'ENTRY_DUPLICATE_ACTIVE_STAY',
  ENTRY_CLOSED_SESSION_LOCKED: 'ENTRY_CLOSED_SESSION_LOCKED',
  ENTRY_ACTIVE_PAYMENT_LOCKED: 'ENTRY_ACTIVE_PAYMENT_LOCKED',
  ENTRY_CORRECTION_REASON_REQUIRED: 'ENTRY_CORRECTION_REASON_REQUIRED',
  ENTRY_EXIT_NOT_AFTER_ENTRY: 'ENTRY_EXIT_NOT_AFTER_ENTRY',

  // Cash sessions (turnos de caja)
  // La caja pedida no existe o es de otro estacionamiento (mismo code para
  // ambos casos: distinguirlos le confirmaría a un tercero que el id existe).
  CASH_SESSION_NOT_FOUND: 'CASH_SESSION_NOT_FOUND',

  // Schedules (opening hours)
  SCHEDULE_NOT_FOUND: 'SCHEDULE_NOT_FOUND',
  SCHEDULE_INVALID_RANGE: 'SCHEDULE_INVALID_RANGE',
  SCHEDULE_OVERLAP: 'SCHEDULE_OVERLAP',

  // Driver API (app del conductor)
  // La playa no existe, no está activa o no tiene ubicación publicada: para el
  // conductor es lo mismo, no se distingue.
  DRIVER_PARKING_NOT_FOUND: 'DRIVER_PARKING_NOT_FOUND',
  // La playa no toma reservas: el servicio está apagado o le falta la tarifa
  // o el cupo de reservas (ver services.reservation_rate_id/reservable_spots).
  DRIVER_RESERVATIONS_DISABLED: 'DRIVER_RESERVATIONS_DISABLED',
  // Ventana de la reserva (ingreso/egreso).
  RESERVATION_EXIT_NOT_AFTER_ENTRY: 'RESERVATION_EXIT_NOT_AFTER_ENTRY',
  RESERVATION_ENTRY_IN_PAST: 'RESERVATION_ENTRY_IN_PAST',
  RESERVATION_ENTRY_TOO_FAR: 'RESERVATION_ENTRY_TOO_FAR',
  RESERVATION_STAY_TOO_LONG: 'RESERVATION_STAY_TOO_LONG',
  // La playa cierra en algún momento entre el ingreso y el egreso.
  RESERVATION_OUTSIDE_OPENING_HOURS: 'RESERVATION_OUTSIDE_OPENING_HOURS',
  // No queda cupo en la ventana pedida (SCRUM-261).
  RESERVATION_NO_CAPACITY: 'RESERVATION_NO_CAPACITY',
  // La reserva no existe o es de otro conductor (mismo code para ambos).
  RESERVATION_NOT_FOUND: 'RESERVATION_NOT_FOUND',
  // Ya empezó o ya estaba cancelada.
  RESERVATION_NOT_CANCELLABLE: 'RESERVATION_NOT_CANCELLABLE',
  // El id (clave de idempotencia) ya lo usó otra reserva distinta.
  RESERVATION_ID_CONFLICT: 'RESERVATION_ID_CONFLICT',
  // La patente de la reserva no es de ningún vehículo del conductor.
  RESERVATION_VEHICLE_NOT_FOUND: 'RESERVATION_VEHICLE_NOT_FOUND',
  // El tipo del vehículo (auto, SUV/pickup, moto) no está entre los que la
  // playa deja reservar.
  RESERVATION_VEHICLE_CATEGORY_NOT_ACCEPTED:
    'RESERVATION_VEHICLE_CATEGORY_NOT_ACCEPTED',
  // La estadía no cae entera dentro del horario de reservas (modo custom).
  RESERVATION_OUTSIDE_RESERVATION_HOURS:
    'RESERVATION_OUTSIDE_RESERVATION_HOURS',
  // Ciclo de vida de la reserva con pago.
  // Aceptar/rechazar una reserva que no está esperando la aceptación del dueño.
  RESERVATION_NOT_PENDING_APPROVAL: 'RESERVATION_NOT_PENDING_APPROVAL',
  // El dueño tardó más que la ventana de aceptación: la reserva ya se rechazó.
  RESERVATION_APPROVAL_EXPIRED: 'RESERVATION_APPROVAL_EXPIRED',
  // Sólo se reintenta un reembolso en estado `failed`.
  RESERVATION_REFUND_NOT_RETRYABLE: 'RESERVATION_REFUND_NOT_RETRYABLE',
  // La retención de 10 min para pagar ya venció.
  RESERVATION_HOLD_EXPIRED: 'RESERVATION_HOLD_EXPIRED',
  // El proveedor de pago no pudo crear el checkout (503).
  RESERVATION_CHECKOUT_UNAVAILABLE: 'RESERVATION_CHECKOUT_UNAVAILABLE',
  // Cliente viejo sin `returnUrl` en producción (422).
  RESERVATION_CLIENT_OUTDATED: 'RESERVATION_CLIENT_OUTDATED',
  // Pedir el checkout de una reserva que ya se pagó.
  RESERVATION_ALREADY_PAID: 'RESERVATION_ALREADY_PAID',
  // Pedir el checkout de una reserva cancelada, rechazada o terminada.
  RESERVATION_NOT_PAYABLE: 'RESERVATION_NOT_PAYABLE',
  // Rechazar o cancelar como dueño exige un motivo.
  RESERVATION_REASON_REQUIRED: 'RESERVATION_REASON_REQUIRED',
  // Vehículos del conductor.
  DRIVER_VEHICLE_NOT_FOUND: 'DRIVER_VEHICLE_NOT_FOUND',
  // El conductor ya tiene otro vehículo con esa patente.
  DRIVER_VEHICLE_PLATE_TAKEN: 'DRIVER_VEHICLE_PLATE_TAKEN',
  // Con una reserva activa no se borra ni se cambia patente o categoría.
  DRIVER_VEHICLE_HAS_ACTIVE_RESERVATION:
    'DRIVER_VEHICLE_HAS_ACTIVE_RESERVATION',
  // El principal se cambia marcando otro; no se puede desmarcar.
  DRIVER_VEHICLE_PRIMARY_REQUIRED: 'DRIVER_VEHICLE_PRIMARY_REQUIRED',

  // Services (amenities)
  SERVICE_NOT_FOUND: 'SERVICE_NOT_FOUND',
  SERVICE_INVALID_CODE: 'SERVICE_INVALID_CODE',
  // Tarifa y cupo de reservas sólo se configuran en ADVANCE_RESERVATION.
  SERVICE_CONFIG_NOT_SUPPORTED: 'SERVICE_CONFIG_NOT_SUPPORTED',
  // La tarifa elegida para las reservas no existe en la playa, está borrada o
  // inactiva.
  SERVICE_RESERVATION_RATE_NOT_FOUND: 'SERVICE_RESERVATION_RATE_NOT_FOUND',
  // El cupo de reservas supera la capacidad declarada de la playa.
  SERVICE_RESERVABLE_SPOTS_EXCEED_CAPACITY:
    'SERVICE_RESERVABLE_SPOTS_EXCEED_CAPACITY',
  // Activar las reservas sin cumplir los requisitos (el body trae `missing`).
  SERVICE_RESERVATION_NOT_READY: 'SERVICE_RESERVATION_NOT_READY',
  // PUT de horarios de reservas con rangos inválidos o superpuestos.
  RESERVATION_HOURS_INVALID: 'RESERVATION_HOURS_INVALID',
  // PUT de horarios de reservas con rangos fuera del horario de apertura.
  RESERVATION_HOURS_OUTSIDE_OPENING: 'RESERVATION_HOURS_OUTSIDE_OPENING',

  // Mercado Pago (integracion de cobros)
  // El webhook llego pero MP_WEBHOOK_SECRET no esta cargada: no podemos
  // verificar la firma. Es un problema de configuracion nuestro, NO una firma
  // invalida, y por eso tiene su propio code.
  MP_WEBHOOK_SECRET_NOT_CONFIGURED: 'MP_WEBHOOK_SECRET_NOT_CONFIGURED',
  // El token cifrado no se pudo descifrar: adulterado, truncado, o cifrado con
  // una clave que ya no esta declarada.
  MP_TOKEN_DECRYPT_FAILED: 'MP_TOKEN_DECRYPT_FAILED',
  // La fila apunta a un `token_key_version` que el entorno no conoce (se borro
  // una clave anterior antes de re-cifrar sus filas).
  MP_TOKEN_KEY_VERSION_UNKNOWN: 'MP_TOKEN_KEY_VERSION_UNKNOWN',
  // La playa no tiene ninguna cuenta de Mercado Pago vinculada (404).
  MP_NOT_LINKED: 'MP_NOT_LINKED',
  // Ya hay una cuenta vinculada y operativa: hay que desvincular antes de
  // volver a correr el OAuth (409).
  MP_ALREADY_LINKED: 'MP_ALREADY_LINKED',
  // La cuenta esta vinculada pero su access token vencio y el refresh no lo
  // pudo renovar: hace falta que el dueno re-autorice (409).
  MP_ACCOUNT_TOKEN_EXPIRED: 'MP_ACCOUNT_TOKEN_EXPIRED',
  // La cuenta se desvinculo (desde nuestro panel o desde Mercado Pago) (409).
  MP_ACCOUNT_REVOKED: 'MP_ACCOUNT_REVOKED',
  // La playa no tiene la direccion estructurada completa y Mercado Pago la
  // exige para `Store.location` (422).
  MP_ENTITY_ADDRESS_INCOMPLETE: 'MP_ENTITY_ADDRESS_INCOMPLETE',
  // El `state` del callback no existe, ya se consumio, vencio, o no pertenece
  // a quien esta llamando. UN SOLO code para los cuatro casos, a proposito: el
  // cliente no tiene por que saber cual fallo (400).
  MP_OAUTH_STATE_INVALID: 'MP_OAUTH_STATE_INVALID',
  // Mercado Pago rechazo el canje del `authorization_code` por tokens (502).
  MP_OAUTH_CODE_EXCHANGE_FAILED: 'MP_OAUTH_CODE_EXCHANGE_FAILED',
  // Fallo la creacion del `Store` en Mercado Pago (502).
  MP_STORE_CREATE_FAILED: 'MP_STORE_CREATE_FAILED',
  // Fallo la creacion (o la lectura) del `POS` en Mercado Pago (502).
  MP_POS_CREATE_FAILED: 'MP_POS_CREATE_FAILED',
  // Fallo la creacion, la lectura o la cancelacion de la `Order` de Mercado
  // Pago: la playa no puede cobrar con QR ahora mismo (502). UN SOLO code para
  // las tres operaciones a proposito: al cliente le sirve lo mismo ("no se
  // pudo generar el cobro con QR") y el detalle de cual fallo ya esta en el
  // `detail` y en el log.
  MP_ORDER_CREATE_FAILED: 'MP_ORDER_CREATE_FAILED',
  // Mercado Pago rechazo la creacion de la preferencia de Checkout Pro de una
  // reserva (502): el conductor no puede pagar ahora mismo.
  MP_PREFERENCE_CREATE_FAILED: 'MP_PREFERENCE_CREATE_FAILED',
  // Fallo la lectura o la busqueda de pagos en Mercado Pago (502). Cubre
  // `GET /v1/payments/{id}` y `GET /v1/payments/search`.
  MP_PAYMENT_READ_FAILED: 'MP_PAYMENT_READ_FAILED',
  // Mercado Pago rechazo el reembolso de un pago (502): sin saldo en la cuenta
  // del vendedor, pago muy viejo (180 dias), monto invalido, etc.
  MP_REFUND_FAILED: 'MP_REFUND_FAILED',
  // Mercado Pago rechazo la cancelacion de un pago pendiente (502).
  MP_PAYMENT_CANCEL_FAILED: 'MP_PAYMENT_CANCEL_FAILED',
  // Mercado Pago contesto que esta caido (5xx propio o 429): es transitorio y
  // el cliente deberia reintentar mas tarde (503).
  MP_UNAVAILABLE: 'MP_UNAVAILABLE',
  // NO HUBO RESPUESTA de Mercado Pago: timeout, DNS caido, socket cortado
  // (502). Es el hermano de `MP_UNAVAILABLE` y NO es un detalle cosmetico:
  // cuando la operacion que murio era un POST, la peticion PUDO HABER LLEGADO
  // igual, asi que el recurso del otro lado puede existir. Eso es lo que
  // separa un intento de cobro recuperable (queda en `created` y se re-POSTea
  // con la misma `X-Idempotency-Key`) de uno terminal (`failed`), y por eso la
  // maquina de estados necesita distinguirlo por `code` y no leyendo el
  // `detail` en ingles. Ver `PaymentIntentsService.create`.
  MP_UNREACHABLE: 'MP_UNREACHABLE',
  // Mercado Pago contesto 2xx pero con un cuerpo inservible: falta el `id`, o
  // no es JSON (502). Mismo problema que `MP_UNREACHABLE` y por eso es un code
  // aparte y no el de la operacion: la operacion SI se ejecuto del otro lado
  // —la orden existe— y lo que perdimos es como nombrarla, asi que tratarla
  // como rechazo terminal dejaria una orden viva en la caja.
  MP_MALFORMED_RESPONSE: 'MP_MALFORMED_RESPONSE',
  // La cuenta esta vinculada y operativa pero le falta el POS (`external_pos_id`
  // en NULL): sin caja no hay QR contra el cual cobrar (409). Se arregla con
  // `POST /tenants/{id}/mercado-pago/pos/resync`, no re-vinculando, y por eso
  // NO comparte code con `MP_NOT_LINKED`: la accion de salida es otra.
  MP_POS_NOT_PROVISIONED: 'MP_POS_NOT_PROVISIONED',

  // Mercado Pago · intentos de cobro con QR (`payment_intents`)
  // El intento pedido no existe o es de otro estacionamiento (404). UN SOLO
  // code para los dos casos, igual que `CASH_SESSION_NOT_FOUND`: distinguirlos
  // le confirmaria a un tercero que el id existe.
  PAYMENT_INTENT_NOT_FOUND: 'PAYMENT_INTENT_NOT_FOUND',
  // Ya hay un cobro vivo para ESA estadia (409): lo frena
  // `payment_intents_entry_live_idx`, que es lo que evita cobrarle dos veces al
  // mismo auto.
  PAYMENT_INTENT_ALREADY_OPEN: 'PAYMENT_INTENT_ALREADY_OPEN',
  // Ya hay un cobro en curso en LA CAJA, sobre otra estadia (409): lo frena
  // `payment_intents_tenant_live_idx`. Con QR estatico el cartel impreso esta
  // atado a un POS y esa caja sostiene una sola orden a la vez. Es un code
  // distinto de `PAYMENT_INTENT_ALREADY_OPEN` a proposito: el operario tiene
  // que saber si el bloqueo es de este auto o del de al lado, porque lo que
  // tiene que hacer es distinto.
  PAYMENT_INTENT_POS_BUSY: 'PAYMENT_INTENT_POS_BUSY',
  // Se intento cancelar un intento que ya no esta vivo (409): ya se pago, ya
  // vencio, ya se cancelo o ya se consumio.
  PAYMENT_INTENT_NOT_CANCELABLE: 'PAYMENT_INTENT_NOT_CANCELABLE',
  // Se intento cobrar con QR una estadia que ya tiene salida registrada (409).
  PAYMENT_INTENT_ENTRY_CLOSED: 'PAYMENT_INTENT_ENTRY_CLOSED',
  // El cierre de estadia mando un `paymentIntentId` que NO se puede consumir
  // (409). UN SOLO code para los cinco casos malos, y es a proposito: ya se
  // consumio, es de otra estadia, es de otra playa, el monto no coincide con el
  // de la linea, o nunca llego a `approved`. Los cinco se detectan con la MISMA
  // sentencia —un `updateMany` con guarda que actualiza 0 filas— y no se puede
  // saber cual fue sin una lectura extra que ademas abriria una carrera entre
  // el SELECT y el UPDATE.
  //
  // Distinguirlos tampoco le serviria a nadie: la accion del operario es
  // identica en los cinco (mirar el estado real del cobro y, si hace falta,
  // generar uno nuevo), y "de otra playa" es justamente el caso donde contar
  // mas seria filtrar la existencia de la fila.
  //
  // El mensaje en espanol lo pone el cliente (`CODE_MESSAGES`), no el `detail`:
  // el operario esta con el cliente adelante, asi que tiene que leer algo como
  // "ese cobro con QR ya se aplico o no corresponde a esta estadia", no una
  // cadena en ingles.
  PAYMENT_INTENT_NOT_CONSUMABLE: 'PAYMENT_INTENT_NOT_CONSUMABLE',
  // Llego una notificacion firmada de Mercado Pago pero no pudimos releer la
  // orden para confirmar su estado real (503). NINGUN cliente nuestro ve este
  // code: el unico que lo recibe es Mercado Pago, y lo unico que le importa es
  // que sea 5xx para reintentar. Existe igual —en vez de dejar propagar el 409
  // de una cuenta rota— porque el contrato del webhook es "el unico 4xx es el
  // 401 de firma invalida", y porque un 200 sin haber leido el estado real
  // seria dar por procesado un pago que nadie verifico.
  MP_WEBHOOK_ORDER_UNVERIFIED: 'MP_WEBHOOK_ORDER_UNVERIFIED',

  // Facturacion electronica (ARCA)
  // La playa no tiene ARCA vinculada (o la integracion esta apagada en este
  // entorno). En GET de la cuenta es el camino feliz de "todavia no vinculo".
  ARCA_NOT_LINKED: 'ARCA_NOT_LINKED',
  // ARCA no respondio, el WSAA rechazo el login o el servicio esta caido. En
  // una factura se guarda como `error_code`: el cobro nunca falla por esto.
  ARCA_UNAVAILABLE: 'ARCA_UNAVAILABLE',
  // El certificado vencio: las facturas quedan pendientes hasta renovarlo.
  ARCA_CERT_EXPIRED: 'ARCA_CERT_EXPIRED',
  // Vinculacion desde el panel (wizard).
  // La playa ya tiene ARCA vinculada: hay que desvincular antes de empezar otra.
  ARCA_ALREADY_LINKED: 'ARCA_ALREADY_LINKED',
  // El paso no corresponde al estado de la vinculacion (p. ej. subir el
  // certificado antes de generar la solicitud).
  ARCA_LINK_STEP_INVALID: 'ARCA_LINK_STEP_INVALID',
  // El CUIT no tiene 11 digitos o falla el digito verificador.
  ARCA_CUIT_INVALID: 'ARCA_CUIT_INVALID',
  // El archivo no es un certificado X.509 de ARCA, o ARCA lo rechazo (por
  // ejemplo, uno de produccion en homologacion).
  ARCA_CERT_INVALID: 'ARCA_CERT_INVALID',
  // El certificado es de otro CUIT.
  ARCA_CERT_CUIT_MISMATCH: 'ARCA_CERT_CUIT_MISMATCH',
  // El certificado no se genero con la solicitud (CSR) de Parkit.
  ARCA_CERT_KEY_MISMATCH: 'ARCA_CERT_KEY_MISMATCH',
  // El certificado existe pero no tiene asociado el servicio (wsfe o la
  // constancia de inscripcion) en el Administrador de Relaciones.
  ARCA_CERT_NOT_AUTHORIZED: 'ARCA_CERT_NOT_AUTHORIZED',
  // El padron no tiene los datos fiscales del CUIT (o faltan cargarlos a mano
  // en homologacion).
  ARCA_PADRON_NOT_FOUND: 'ARCA_PADRON_NOT_FOUND',
  // El punto de venta no existe en ARCA o no es de web services.
  ARCA_POS_NOT_FOUND: 'ARCA_POS_NOT_FOUND',
  // El punto de venta esta bloqueado o dado de baja.
  ARCA_POS_DISABLED: 'ARCA_POS_DISABLED',
  // Faltan Ingresos Brutos o la fecha de inicio de actividades: van impresos
  // en la factura (RG 1415, Anexo II), asi que sin ellos no se vincula.
  ARCA_FISCAL_DATA_INCOMPLETE: 'ARCA_FISCAL_DATA_INCOMPLETE',
  // La estadia ya tiene factura emitida: no se re-emite ni se cambia el monto.
  INVOICE_ALREADY_ISSUED: 'INVOICE_ALREADY_ISSUED',
  // Otra emision de la misma factura esta en curso (web y desktop a la vez).
  INVOICE_IN_PROGRESS: 'INVOICE_IN_PROGRESS',
  // ARCA rechazo el comprobante; el motivo va en `error_message`.
  INVOICE_REJECTED: 'INVOICE_REJECTED',
  // Consumidor final por encima del tope: hay que identificar al receptor.
  INVOICE_RECEIVER_REQUIRED: 'INVOICE_RECEIVER_REQUIRED',
  // La estadia no se puede facturar: sigue abierta o se cobro $0.
  INVOICE_NOT_INVOICEABLE: 'INVOICE_NOT_INVOICEABLE',
  // Receptor con CUIT: el padron no tiene datos de ese CUIT (produccion).
  INVOICE_RECEIVER_NOT_FOUND: 'INVOICE_RECEIVER_NOT_FOUND',
  // DEPRECADO desde la Etapa 5: un receptor que no recibe A sale B
  // identificada. Queda porque hay facturas viejas con este codigo guardado.
  INVOICE_RECEIVER_NOT_A: 'INVOICE_RECEIVER_NOT_A',
  // El comprobante (PDF) solo existe para una factura emitida (con CAE).
  INVOICE_NOT_ISSUED: 'INVOICE_NOT_ISSUED',

  // Validacion del body / query
  VALIDATION_FAILED: 'VALIDATION_FAILED',

  // Errores genericos por HTTP status (fallback cuando no hay codigo mas especifico)
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNPROCESSABLE_ENTITY: 'UNPROCESSABLE_ENTITY',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  GATEWAY_TIMEOUT: 'GATEWAY_TIMEOUT',

  // Persistencia (Prisma)
  DB_NOT_FOUND: 'DB_NOT_FOUND',
  DB_UNIQUE_CONSTRAINT: 'DB_UNIQUE_CONSTRAINT',
  DB_FOREIGN_KEY_VIOLATION: 'DB_FOREIGN_KEY_VIOLATION',
  DB_VALIDATION_ERROR: 'DB_VALIDATION_ERROR',
  DB_CONNECTION_TIMEOUT: 'DB_CONNECTION_TIMEOUT',
  DB_ERROR: 'DB_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Default code for generic HTTP errors when no producer set a more specific
 * one. Acts as a safety net in the filter.
 */
export function defaultCodeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ErrorCodes.BAD_REQUEST;
    case 401:
      return ErrorCodes.UNAUTHORIZED;
    case 403:
      return ErrorCodes.FORBIDDEN;
    case 404:
      return ErrorCodes.NOT_FOUND;
    case 409:
      return ErrorCodes.CONFLICT;
    case 422:
      return ErrorCodes.UNPROCESSABLE_ENTITY;
    case 429:
      return ErrorCodes.TOO_MANY_REQUESTS;
    case 503:
      return ErrorCodes.SERVICE_UNAVAILABLE;
    case 504:
      return ErrorCodes.GATEWAY_TIMEOUT;
    default:
      return ErrorCodes.INTERNAL_ERROR;
  }
}
