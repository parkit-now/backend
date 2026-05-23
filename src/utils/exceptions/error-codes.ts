/**
 * Catalogo de codigos estables de error de la API Parkit.
 *
 * Cada codigo identifica un caso de error de forma unica e independiente
 * del wording del campo `detail`. Los clientes (web/desktop/mobile)
 * mantienen un diccionario `codigo -> mensaje en idioma del usuario` y
 * lookupean por este valor.
 *
 * Reglas:
 *  - SCREAMING_SNAKE_CASE.
 *  - Prefijo por dominio cuando ayuda a desambiguar (AUTH_, DB_).
 *  - NUNCA renombrar un codigo ya publicado. Si cambia la semantica,
 *    agregar uno nuevo y deprecar el viejo.
 *  - Para errores de validacion field-level se usa el nombre del
 *    constraint de class-validator (camelCase) como codigo: `isEmail`,
 *    `minLength`, etc. — sigue siendo estable porque proviene de la
 *    libreria.
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
 * Codigo por defecto para errores HTTP genericos cuando ningun productor
 * indico uno mas especifico. Sirve como red de seguridad en el filter.
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
