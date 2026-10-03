/**
 * MOTOR DE COBRO POR ESTADÍA — el precio que se le cobra al conductor.
 *
 * ⚠️ GEMELO EXACTO de `front-desktop/src/features/entries/pricing.ts`. El desktop lo usa para
 * sugerirle el monto al operador; el backend, para detectar subcobros y escribir
 * `ENTRY_UNDERCHARGED` en auditoría. Si las dos copias divergen, el backend marca
 * como subcobrado lo que el POS cobró bien. Los dos repos comparten la misma
 * tabla de casos (`pricing.spec.ts` / `pricing.test.ts`): una divergencia tiene
 * que romper CI, no aparecer semanas después en la pantalla de Auditoría.
 *
 * Reglas del dueño de producto:
 *
 *  1. Primera hora obligatoria: al entrar se cobra la hora completa, sin
 *     fracciones dentro de esos 60 minutos.
 *  2. Desde el minuto 61 se cobra por fracciones de 5 minutos, y la fracción se
 *     cobra al EMPEZARLA (el minuto 61 ya cobra una entera).
 *  3. Tope por hora: lo acumulado en fracciones dentro de un mismo bloque de una
 *     hora nunca supera el precio de la hora.
 *  4. Topes de media estadía (12h) y estadía (24h): el total se congela al
 *     llegar a cada uno.
 *  5. Pasado un tope NO se vuelve a cobrar una hora completa: se sigue por
 *     fracciones sumadas sobre el tope alcanzado (24h + 5min = estadía + 1
 *     fracción).
 *  6. Pasadas las 24h el ciclo reinicia: los topes se recalculan por período de
 *     24h, pero la hora obligatoria de la regla 1 aplica UNA sola vez, al inicio
 *     de la estadía.
 */

export interface StayPrices {
  hour: number;
  /** Precio de un bloque de 5 minutos. */
  fraction: number;
  /** Tope de las 12h. `<= 0` = la tarifa no tiene este escalón. */
  mediaEstadia: number;
  /** Tope de las 24h. `<= 0` = la tarifa no tiene tope diario. */
  stay: number;
}

const MINUTES_PER_FRACTION = 5;
const MINUTES_PER_HOUR = 60;
/** Múltiplo de 60: el cambio de tope nunca parte un bloque horario al medio. */
const MINUTES_PER_HALF_DAY = 720;
/** Múltiplo de 60: los bloques siguen alineados a la hora al cruzar de día. */
const MINUTES_PER_DAY = 1440;

/** Un precio inválido vale 0. Un `NaN` de la base no puede llegar al cobro. */
function money(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Un tope ausente es SIN TOPE, nunca tope cero.
 *
 * Esto arregla un bug de plata que hoy está en producción en los dos repos: el
 * cálculo termina en `Math.min(total, stayPrice)` y los callers pasan
 * `parseFloat(rateSnapshotStayPriceArs ?? '0')`. Con un snapshot sin precio de
 * estadía —entries viejos, o creados sin tarifa— el sugerido es `min(total, 0)`
 * y el auto sale gratis.
 */
function tier(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : Infinity;
}

function roundMoney(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

/**
 * Precio de UN período de 24h, desde su minuto 0 hasta `upTo` (0..1440).
 *
 * `withMandatoryHour` distingue el arranque de la estadía (regla 1) de la
 * continuación después de un tope (regla 5). Itera como mucho 24 veces.
 */
function periodPrice(
  upTo: number,
  withMandatoryHour: boolean,
  hour: number,
  fraction: number,
  halfCap: number,
  dayCap: number,
): number {
  let total = 0;
  let blockStart = 0;

  if (withMandatoryHour) {
    // Acotada por el tope vigente: con `hour > mediaEstadia` la regla 4 se
    // violaría desde el minuto uno.
    total = Math.min(hour, halfCap);
    blockStart = MINUTES_PER_HOUR;
  }

  while (blockStart < upTo) {
    const minutesInBlock =
      Math.min(upTo, blockStart + MINUTES_PER_HOUR) - blockStart;

    // Regla 2: la fracción se cobra empezada. Minuto 60 exacto → 0 fracciones;
    // minuto 61 → 1.
    const startedFractions = Math.ceil(minutesInBlock / MINUTES_PER_FRACTION);

    // Regla 3: el tope de la hora se aplica al bloque, no al total.
    const blockCost = Math.min(startedFractions * fraction, hour);

    // ACÁ VIVE LA REGLA 5. El tope se aplica al total corriente en CADA bloque,
    // no a la suma cruda al final. Por eso a las 12h el total queda congelado en
    // media estadía y desde el minuto 720 las fracciones se apilan SOBRE ese
    // tope (12h05 = media + 1 fracción) en vez de saltar a la estadía entera.
    const cap = blockStart < MINUTES_PER_HALF_DAY ? halfCap : dayCap;
    total = Math.min(total + blockCost, cap);

    blockStart += MINUTES_PER_HOUR;
  }

  return total;
}

export function calcStayPrice(
  elapsedMinutes: number,
  prices: StayPrices,
): number {
  // Egreso anterior al ingreso, `NaN`, `Infinity`: no hay estadía que cobrar.
  // No se tira excepción — el backend recalcula esto al corregir un egreso y una
  // excepción en el medio frena la barrera. El orden se valida en el DTO.
  if (!Number.isFinite(elapsedMinutes) || elapsedMinutes <= 0) return 0;

  const hour = money(prices.hour);
  const fraction = money(prices.fraction);
  const dayCap = tier(prices.stay);
  // Media estadía NUNCA puede superar la estadía: un tope que baja hace que el
  // precio CAIGA al cruzar las 12h, y el precio nunca puede decrecer con el
  // tiempo. El motor no puede confiar en la validación del formulario: la tarifa
  // le llega como snapshot congelado, escrito quizá con reglas viejas.
  const halfCap = Math.min(tier(prices.mediaEstadia), dayCap);

  // Los segundos no son unidad de cobro: se truncan para que el precio coincida
  // con la duración que ve el operador en pantalla (`formatMinutes` también
  // trunca). El truncado va DESPUÉS del guard de arriba: si no, una estadía de
  // 30 segundos truncaría a 0 y el auto saldría gratis en vez de pagar la hora
  // obligatoria.
  const minutes = Math.floor(elapsedMinutes);

  const days = Math.floor(minutes / MINUTES_PER_DAY);
  const rest = minutes - days * MINUTES_PER_DAY;

  if (days === 0) {
    return roundMoney(periodPrice(rest, true, hour, fraction, halfCap, dayCap));
  }

  // Un día completo vale una estadía SOLO si los topes llegan a morder. Con una
  // tarifa sin tope diario vale 24 bloques de hora, y con `12 × fracción < hora`
  // el día 1 sale más caro que los siguientes (paga la hora obligatoria donde
  // los otros pagan fracciones). Por eso se calculan los dos, en vez de asumir
  // `días × estadía`.
  const firstDay = periodPrice(
    MINUTES_PER_DAY,
    true,
    hour,
    fraction,
    halfCap,
    dayCap,
  );
  const otherDay = periodPrice(
    MINUTES_PER_DAY,
    false,
    hour,
    fraction,
    halfCap,
    dayCap,
  );

  return roundMoney(
    firstDay +
      (days - 1) * otherDay +
      periodPrice(rest, false, hour, fraction, halfCap, dayCap),
  );
}

/**
 * EXCEDENTE DE UNA ESTADÍA CON RESERVA PREPAGA — lo que se cobra en la caja.
 *
 * El conductor que reservó ya pagó por Mercado Pago (`prepaid`). Al salir se
 * cobra la estadía completa menos ese prepago, y nunca menos de 0: si salió
 * antes de lo reservado no se le devuelve nada en la caja (la reserva no se
 * reembolsa por uso parcial).
 *
 *   excedente = max(calcStayPrice(total) − prepagado, 0)
 *
 * Un prepago ausente, negativo o basura vale 0 (la estadía se cobra entera),
 * igual que un precio basura en `calcStayPrice`. Redondeado a centavos.
 */
export function calcAmountDue(
  stayTotal: number,
  prepaid: number | null | undefined,
): number {
  const total = money(stayTotal);
  const paid = prepaid == null ? 0 : money(prepaid);
  return roundMoney(Math.max(total - paid, 0));
}
