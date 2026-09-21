/**
 * Normaliza un email en un solo lugar.
 *
 * `public.users.email` se copia verbatim de `auth.users.email` en el trigger de
 * provisioning, y el índice único de Postgres distingue mayúsculas. Quien busca
 * una cuenta por mail tiene que normalizar igual que quien la dio de alta, o
 * `Ana@Example.com` y `ana@example.com` se comportan como dos personas
 * distintas.
 *
 * Lo usan el DTO de alta de personal (como `@Transform`) y `TenantStaffService`
 * (sobre un `string` ya validado). Vive acá para que no se desincronicen.
 */
export const normalizeEmail = (value: string): string =>
  value.trim().toLowerCase();

/** Adaptador para `@Transform`, que recibe un `unknown` sin validar todavía. */
export const normalizeEmailField = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? normalizeEmail(value) : value;
