/**
 * Destinos a los que se puede redirigir al conductor al volver del checkout.
 * Son todos inofensivos: deep links de la app (`parkit://`), Expo Go (`exp://`,
 * hace falta para probar Expo Go contra producción) y Expo web en local. La
 * barra final de `localhost:8081/` evita `http://localhost:8081.evil.com`.
 */
const ALLOWED_PREFIXES = ['parkit://', 'exp://', 'http://localhost:8081/'];

// Espacios y caracteres de control (incluye CR/LF, que permitirían inyectar headers).
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\s\u0000-\u001f\u007f]/;

export function isAllowedReturnUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  if (FORBIDDEN_CHARS.test(url)) return false;
  return ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix));
}
