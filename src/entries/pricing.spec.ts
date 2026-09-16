import { calcStayPrice, type StayPrices } from './pricing';

/**
 * ⚠️ ESTA TABLA ES GEMELA de `front-desktop/src/features/entries/pricing.test.ts`.
 *
 * El motor está duplicado a mano en los dos repos (ver la cabecera de
 * `pricing.ts`). Esta tabla es lo único que garantiza que no diverjan: si tocás
 * una copia, copiá la tabla entera a la otra. Una divergencia silenciosa hace
 * que el backend audite como subcobro lo que el POS cobró bien.
 *
 * Precios del dueño de producto salvo donde se indique:
 * hora $4.000 · fracción (5 min) $400 · media estadía $12.000 · estadía $18.000
 */
const P: StayPrices = {
  hour: 4000,
  fraction: 400,
  mediaEstadia: 12000,
  stay: 18000,
};

interface Case {
  minutes: number;
  expected: number;
  prices?: Partial<StayPrices>;
  why: string;
}

const CASES: Case[] = [
  // ── Entradas degeneradas ───────────────────────────────────────────────
  { minutes: NaN, expected: 0, why: 'NaN no es una estadía' },
  { minutes: Infinity, expected: 0, why: 'duración no finita' },
  {
    minutes: -5,
    expected: 0,
    why: 'egreso anterior al ingreso: 0, sin excepción',
  },
  { minutes: 0, expected: 0, why: 'no hubo estadía' },
  {
    minutes: 0.5,
    expected: 4000,
    why: '30 segundos igual pagan la hora obligatoria: el truncado va DESPUÉS del guard',
  },

  // ── Regla 1: primera hora obligatoria ──────────────────────────────────
  { minutes: 1, expected: 4000, why: 'un minuto ya cuesta la hora entera' },
  { minutes: 10, expected: 4000, why: 'ejemplo del dueño de producto' },
  {
    minutes: 59,
    expected: 4000,
    why: 'sin fracciones dentro de la primera hora',
  },
  {
    minutes: 60,
    expected: 4000,
    why: 'BORDE: el minuto 60 entra en la hora paga; la fracción que arranca EN el minuto 60 no está empezada',
  },
  {
    minutes: 60.5,
    expected: 4000,
    why: 'segundos truncados — el origen del reclamo "me cobró una fracción de más"',
  },
  { minutes: 60.999, expected: 4000, why: 'idem, justo antes del minuto 61' },

  // ── Reglas 2 y 3: fracciones y tope por hora ───────────────────────────
  {
    minutes: 61,
    expected: 4400,
    why: 'BORDE: primera fracción empezada, ceil(1/5) = 1',
  },
  { minutes: 65, expected: 4400, why: 'ejemplo del dueño de producto: 1h05' },
  { minutes: 66, expected: 4800, why: 'segunda fracción: ceil(6/5) = 2' },
  {
    minutes: 105,
    expected: 7600,
    why: '9 fracciones; el tope por hora todavía no muerde',
  },
  {
    minutes: 106,
    expected: 8000,
    why: 'TOPE POR HORA: 10 fracciones = 4.000 = la hora. Hasta el minuto 120 no sube más',
  },
  { minutes: 119, expected: 8000, why: 'meseta dentro del bloque' },
  { minutes: 120, expected: 8000, why: 'ejemplo del dueño de producto: 2h' },
  {
    minutes: 121,
    expected: 8400,
    why: 'arranca el bloque siguiente y el tope por hora se reinicia',
  },
  { minutes: 165, expected: 11600, why: '4.000 + 4.000 + 9 fracciones' },

  // ── Regla 4: tope de media estadía ─────────────────────────────────────
  {
    minutes: 166,
    expected: 12000,
    why: 'la media estadía se alcanza a las 2h46, no a las 3h',
  },
  { minutes: 180, expected: 12000, why: 'congelado en media estadía' },
  { minutes: 240, expected: 12000, why: 'ejemplo del dueño de producto: 4h' },
  {
    minutes: 719,
    expected: 12000,
    why: 'BORDE: el bloque [660,720) usa el tope de media estadía, no el de estadía',
  },
  { minutes: 720, expected: 12000, why: 'BORDE: 12h exactas' },

  // ── Regla 5: después del tope van fracciones, NO una hora nueva ────────
  {
    minutes: 721,
    expected: 12400,
    why: 'REGLA 5: 12h01 = media + 1 fracción, no media + 1 hora',
  },
  {
    minutes: 725,
    expected: 12400,
    why: 'ejemplo del dueño de producto: 12h05',
  },
  { minutes: 726, expected: 12800, why: 'segunda fracción sobre el tope' },
  { minutes: 765, expected: 15600, why: '9 fracciones sobre la media estadía' },
  {
    minutes: 766,
    expected: 16000,
    why: 'tope por hora otra vez: media + hora',
  },
  { minutes: 780, expected: 16000, why: 'meseta hasta el fin del bloque' },
  {
    minutes: 800,
    expected: 17600,
    why: 'BORDE: 4 fracciones más, un paso antes de tocar la estadía',
  },

  // ── Regla 4: tope de estadía ───────────────────────────────────────────
  {
    minutes: 801,
    expected: 18000,
    why: 'la estadía se alcanza a las 13h21',
  },
  { minutes: 1000, expected: 18000, why: 'congelado en estadía' },
  { minutes: 1439, expected: 18000, why: 'BORDE: un minuto antes de las 24h' },
  { minutes: 1440, expected: 18000, why: 'BORDE: 24h exactas = una estadía' },

  // ── Regla 6: el ciclo reinicia, sin hora obligatoria ───────────────────
  {
    minutes: 1441,
    expected: 18400,
    why: 'REGLA 5 en las 24h: estadía + 1 fracción, NO estadía + 1 hora',
  },
  {
    minutes: 1445,
    expected: 18400,
    why: 'ejemplo del dueño de producto: 24h05',
  },
  { minutes: 1446, expected: 18800, why: 'segunda fracción del período 2' },
  {
    minutes: 1485,
    expected: 21600,
    why: 'sin hora obligatoria, el día 2 arranca subiendo de a fracciones',
  },
  { minutes: 1486, expected: 22000, why: 'tope por hora del período 2' },
  {
    minutes: 1605,
    expected: 29600,
    why: 'estadía + 4.000 + 4.000 + 9 fracciones',
  },
  {
    minutes: 1606,
    expected: 30000,
    why: 'media estadía del período 2 (su minuto 166)',
  },
  {
    minutes: 2160,
    expected: 30000,
    why: 'BORDE 36h: congelado en estadía + media',
  },
  {
    minutes: 2161,
    expected: 30400,
    why: 'regla 5 sobre el tope del período 2',
  },
  { minutes: 2240, expected: 35600, why: 'un paso antes de tocar 2 estadías' },
  {
    minutes: 2241,
    expected: 36000,
    why: 'estadía del período 2 (su minuto 801)',
  },
  { minutes: 2880, expected: 36000, why: 'ejemplo del dueño de producto: 48h' },
  { minutes: 2881, expected: 36400, why: 'regla 5 en las 48h' },
  {
    minutes: 4320,
    expected: 54000,
    why: '72h = 3 estadías; los días cerrados son aritmética, no loop',
  },
  {
    minutes: 10080,
    expected: 126000,
    why: 'una semana = 7 estadías, sin iterar 2.016 fracciones',
  },

  // ── Ejemplo del dueño de producto con fracción $1.000 (ejercita regla 3)
  {
    minutes: 61,
    expected: 5000,
    prices: { fraction: 1000 },
    why: 'una fracción cara, todavía por debajo de la hora',
  },
  {
    minutes: 80,
    expected: 8000,
    prices: { fraction: 1000 },
    why: '4 fracciones = 4.000 = la hora, exacto',
  },
  {
    minutes: 81,
    expected: 8000,
    prices: { fraction: 1000 },
    why: 'la quinta fracción no suma: tope por hora',
  },
  {
    minutes: 85,
    expected: 8000,
    prices: { fraction: 1000 },
    why: 'ejemplo del dueño de producto: 1h25 = 5 fracciones topadas a la hora',
  },

  // ── Tarifa sin media estadía: TODA la base de hoy ──────────────────────
  {
    minutes: 60,
    expected: 4000,
    prices: { mediaEstadia: 0 },
    why: 'media estadía 0 = la tarifa NO tiene ese escalón, no que sea gratis',
  },
  {
    minutes: 240,
    expected: 16000,
    prices: { mediaEstadia: 0 },
    why: 'sin el escalón de 12h el precio sigue subiendo: 4 bloques de hora',
  },
  {
    minutes: 260,
    expected: 17600,
    prices: { mediaEstadia: 0 },
    why: 'un paso antes de tocar la estadía',
  },
  {
    minutes: 261,
    expected: 18000,
    prices: { mediaEstadia: 0 },
    why: 'sin escalón de 12h la estadía se alcanza a las 4h21',
  },
  {
    minutes: 720,
    expected: 18000,
    prices: { mediaEstadia: 0 },
    why: 'EL BUG A EVITAR: ni 0 ni 12.000',
  },
  {
    minutes: 1445,
    expected: 18400,
    prices: { mediaEstadia: 0 },
    why: 'la regla 5 no depende de la media estadía',
  },

  // ── Regresión: tope ausente ≠ tope cero (bug de plata en producción) ───
  {
    minutes: 600,
    expected: 40000,
    prices: { mediaEstadia: 0, stay: 0 },
    why: 'SIN TOPES el auto NO sale gratis: hoy `min(total, 0)` lo dejaba salir sin pagar',
  },
  {
    minutes: 1440,
    expected: 96000,
    prices: { mediaEstadia: 0, stay: 0 },
    why: 'sin tope diario el día vale 24 bloques de hora — NO `días × estadía`',
  },
  {
    minutes: 1441,
    expected: 96400,
    prices: { mediaEstadia: 0, stay: 0 },
    why: 'y sigue sumando fracciones',
  },
  {
    minutes: 1440,
    expected: 31600,
    prices: { fraction: 100, mediaEstadia: 0, stay: 0 },
    why: 'con 12×fracción < hora el día 1 vale MÁS que el día 2 (28.800): por eso no alcanza con un solo valor de día',
  },
  {
    minutes: 2880,
    expected: 60400,
    prices: { fraction: 100, mediaEstadia: 0, stay: 0 },
    why: 'día 1 (31.600) + día 2 (28.800), no 2 × día 1',
  },

  // ── Precios incoherentes ───────────────────────────────────────────────
  {
    minutes: 719,
    expected: 18000,
    prices: { mediaEstadia: 50000 },
    why: 'media > estadía se acota a la estadía: nunca se cobra de más',
  },
  {
    minutes: 721,
    expected: 18000,
    prices: { mediaEstadia: 50000 },
    why: 'MONOTONÍA: sin acotar, el precio CAÍA de 48.000 a 18.000 al cruzar las 12h',
  },
  {
    minutes: 61,
    expected: 8000,
    prices: { fraction: 5000 },
    why: 'fracción > hora queda acotada por el tope por hora',
  },
  {
    minutes: 121,
    expected: 12000,
    prices: { fraction: 5000 },
    why: 'y no se acumula más allá de una hora por bloque',
  },
  {
    minutes: 600,
    expected: 4000,
    prices: { hour: 8000, mediaEstadia: 4000 },
    why: 'hora > media estadía: la hora obligatoria también se acota al tope',
  },

  // ── Precios ausentes o basura ──────────────────────────────────────────
  {
    minutes: 60,
    expected: 0,
    prices: { hour: NaN },
    why: 'un precio basura no propaga NaN al importe cobrable',
  },
  {
    minutes: 600,
    expected: 0,
    prices: { hour: 0, fraction: 0, mediaEstadia: 0, stay: 0 },
    why: 'tarifa vacía: 0, ni NaN ni Infinity',
  },
  {
    minutes: 600,
    expected: 0,
    prices: { hour: -4000, fraction: -400 },
    why: 'precios negativos se tratan como ausentes',
  },
];

describe('calcStayPrice', () => {
  for (const testCase of CASES) {
    const label =
      testCase.prices === undefined
        ? `${testCase.minutes} min → ${testCase.expected}`
        : `${testCase.minutes} min con ${JSON.stringify(testCase.prices)} → ${testCase.expected}`;

    it(`${label} — ${testCase.why}`, () => {
      expect(
        calcStayPrice(testCase.minutes, { ...P, ...testCase.prices }),
      ).toBe(testCase.expected);
    });
  }

  /**
   * La invariante dura: el precio NUNCA baja al pasar el tiempo.
   *
   * Es lo que protege el motor a largo plazo, más que cualquier caso puntual.
   * Un conductor que espera 2 minutos más y paga menos es un agujero de plata, y
   * la única forma de producirlo es que un tope decrezca (media > estadía sin
   * acotar) o que un día cerrado valga más que el mismo tiempo abierto.
   */
  it('nunca baja al crecer la estadía, con ninguna combinación de precios', () => {
    const combos: StayPrices[] = [];
    for (const hour of [0, 100, 4000]) {
      for (const fraction of [0, 10, 400, 1000, 5000]) {
        for (const mediaEstadia of [0, 1000, 12000, 50000]) {
          for (const stay of [0, 2000, 18000, 1_000_000]) {
            combos.push({ hour, fraction, mediaEstadia, stay });
          }
        }
      }
    }

    for (const prices of combos) {
      let previous = -1;
      // Tres días más un poco: cubre los dos cruces de tope y dos rollovers.
      for (let minutes = 0; minutes <= 4400; minutes += 1) {
        const price = calcStayPrice(minutes, prices);
        if (price < previous) {
          throw new Error(
            `El precio bajó en el minuto ${minutes} (${previous} → ${price}) con ${JSON.stringify(prices)}`,
          );
        }
        previous = price;
      }
    }
  });
});
