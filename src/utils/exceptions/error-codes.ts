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

  // Services (amenities)
  SERVICE_NOT_FOUND: 'SERVICE_NOT_FOUND',
  SERVICE_INVALID_CODE: 'SERVICE_INVALID_CODE',

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
  // Mercado Pago contesto que esta caido (5xx propio o 429): es transitorio y
  // el cliente deberia reintentar mas tarde (503).
  MP_UNAVAILABLE: 'MP_UNAVAILABLE',

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
