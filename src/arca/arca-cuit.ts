/** Pesos del dígito verificador del CUIT/CUIL (módulo 11). */
const CUIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;

/** Deja sólo los dígitos: acepta `20-12345678-3` y `20 12345678 3`. */
export function normalizeCuit(raw: string): string {
  return raw.replace(/\D/g, '');
}

/**
 * Valida un CUIT normalizado: 11 dígitos y dígito verificador correcto.
 *
 * Duplicada en front-web (`features/owner/sections/integraciones/arca/cuit.ts`):
 * el wizard avisa antes de mandar, pero la regla que vale es esta.
 */
export function isValidCuit(cuit: string): boolean {
  if (!/^\d{11}$/.test(cuit)) return false;

  const digits = [...cuit].map(Number);
  const sum = CUIT_WEIGHTS.reduce((acc, w, i) => acc + w * digits[i], 0);
  const mod = 11 - (sum % 11);
  // 11 → 0; 10 no es un verificador válido (ARCA reasigna el prefijo).
  const expected = mod === 11 ? 0 : mod;
  return expected !== 10 && expected === digits[10];
}
