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

  // Admin · parkings (tenants managed from the Ops panel)
  PARKING_NOT_FOUND: 'PARKING_NOT_FOUND',

  // Admin · users
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_DELETE_FAILED: 'USER_DELETE_FAILED',
  MEMBERSHIP_ALREADY_EXISTS: 'MEMBERSHIP_ALREADY_EXISTS',
  MEMBERSHIP_NOT_FOUND: 'MEMBERSHIP_NOT_FOUND',

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
  VEHICLE_NOT_OWNED_BY_TENANT: 'VEHICLE_NOT_OWNED_BY_TENANT',

  // Payment methods
  PAYMENT_METHOD_NOT_FOUND: 'PAYMENT_METHOD_NOT_FOUND',
  PAYMENT_METHOD_SYSTEM_LOCKED: 'PAYMENT_METHOD_SYSTEM_LOCKED',

  // Entries (vehicle stays)
  ENTRY_DUPLICATE_ACTIVE_STAY: 'ENTRY_DUPLICATE_ACTIVE_STAY',

  // Schedules (opening hours)
  SCHEDULE_NOT_FOUND: 'SCHEDULE_NOT_FOUND',
  SCHEDULE_INVALID_RANGE: 'SCHEDULE_INVALID_RANGE',
  SCHEDULE_OVERLAP: 'SCHEDULE_OVERLAP',

  // Services (amenities)
  SERVICE_NOT_FOUND: 'SERVICE_NOT_FOUND',
  SERVICE_INVALID_CODE: 'SERVICE_INVALID_CODE',

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
