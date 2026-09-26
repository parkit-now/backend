export type SalesPointCheck = 'ok' | 'not_found' | 'disabled' | 'empty';

interface RawSalesPoint {
  nro?: number | string;
  bloqueado?: string;
  fechaBaja?: string;
}

/**
 * Busca `ptoVta` en la respuesta de `FEParamGetPtosVenta`, que lista SOLO los
 * puntos de venta habilitados para web services (uno de «Comprobantes en
 * línea» no aparece: es el error 11002 al emitir).
 *
 * `empty`: ARCA no devolvió ninguno. Pasa siempre en homologación, donde no
 * se dan de alta puntos de venta; quien llama decide si alcanza con que
 * `getLastVoucher` responda.
 */
export function checkSalesPoint(raw: unknown, ptoVta: number): SalesPointCheck {
  const list = extractSalesPoints(raw);
  if (list.length === 0) return 'empty';

  const point = list.find((p) => Number(p.nro) === ptoVta);
  if (!point) return 'not_found';

  const baja = point.fechaBaja?.trim();
  if (point.bloqueado === 'S' || (baja && baja !== 'NULL')) return 'disabled';
  return 'ok';
}

function extractSalesPoints(raw: unknown): RawSalesPoint[] {
  type Response = {
    resultGet?: { ptoVenta?: RawSalesPoint | RawSalesPoint[] };
  } | null;
  const result = (raw as Response)?.resultGet?.ptoVenta;
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}
