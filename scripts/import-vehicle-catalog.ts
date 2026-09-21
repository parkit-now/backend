/**
 * Importa el catálogo de autos del mercado argentino desde thecarsbase.com y
 * escribe `scripts/data/vehicle-catalog.json`.
 *
 *   make catalog-import LIMIT=20   # smoke: 20 modelos
 *   make catalog-import            # completo: ~1.150 modelos, ~20 min
 *
 * ESTE ES EL ÚNICO ARCHIVO DEL REPO QUE TOCA LA RED. No corre en ningún hook ni
 * en el pipeline, igual que `gen-vehicle-catalog.ts`: es una herramienta de
 * desarrollo y su output queda versionado en JSON. El generador que emite el
 * SQL es puro y lee ese JSON, así que regenerar la migración no re-scrapea.
 *
 * POR QUÉ SCRAPING Y NO LA API
 *
 * thecarsbase vende el acceso por API (packs prepagos). Las páginas de fichas
 * son públicas y su `robots.txt` las permite explícitamente:
 *
 *     User-Agent: *
 *     Allow: /
 *     Disallow: /api/ /admin /login /explorer /compare /export /specs/
 *
 * Marca, modelo y carrocería son hechos, no obra. Aun así el importador se
 * comporta: un request por vez, 1s de pausa, User-Agent identificable, y caché
 * en disco para no volver a pedir lo mismo. Si esto pasa a re-sincronizarse
 * seguido, comprar el pack de API es la salida limpia (devuelve JSON y no se
 * rompe cuando rediseñan el HTML).
 *
 * DE DÓNDE SALE CADA DATO
 *
 * Los sitemaps evitan tener que crawlear el sitio:
 *
 *   sitemaps/autos-{0,1,2}.xml   54.192 URLs de fichas marca/modelo/año/versión
 *                                (26.547 son de Uruguay y se descartan; quedan
 *                                 27.645, que es exactamente lo que el sitio
 *                                 declara para Argentina)
 *
 * Se agrupa por (marca, modelo) y se baja UNA ficha por modelo —la del año más
 * nuevo—, porque esa única página ya trae las tres cosas que necesitamos:
 *
 *   - marca y modelo con su casing y acentos reales, del breadcrumb JSON-LD.
 *     NO se de-sluguea la URL: es lossy (`c3-aircross`, `mgs5-ev`,
 *     `land-cruiser`) y produciría nombres que no existen.
 *   - la carrocería, de <section id="carroceria">.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ORIGIN = 'https://www.thecarsbase.com';
const SITEMAPS = [
  `${ORIGIN}/sitemaps/autos-0.xml`,
  `${ORIGIN}/sitemaps/autos-1.xml`,
  `${ORIGIN}/sitemaps/autos-2.xml`,
];

const OUT_FILE = join(__dirname, 'data', 'vehicle-catalog.json');
const CACHE_DIR = join(__dirname, '.cache', 'thecarsbase');

/** Pausa entre requests. Cortesía, no rendimiento: no hay apuro. */
const DELAY_MS = 1157;
const MAX_RETRIES = 3;

/**
 * Identificable a propósito. Hacerse pasar por un Chrome es justo lo que
 * convierte "leer páginas públicas permitidas" en "evadir".
 */
const USER_AGENT =
  'parkit-catalog-import/1.0 (+https://github.com/parkit-now; uso interno, 1 req/s)';

export interface CatalogEntry {
  brand: string;
  model: string;
  /** Carrocería tal cual la publica la fuente. Se mapea en vehicle-types.ts. */
  carroceria: string;
  /** Ficha de la que salió la fila, para poder auditarla después. */
  source: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv: string[]): { limit: number | null } {
  const i = argv.indexOf('--limit');
  if (i === -1) return { limit: null };
  const limit = Number(argv[i + 1]);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`--limit espera un entero positivo, recibió "${argv[i + 1]}"`);
  }
  return { limit };
}

/** GET con reintentos y backoff. Sin caché: los sitemaps se bajan una vez. */
async function fetchText(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) await sleep(DELAY_MS * attempt * 2);
    }
  }
  throw new Error(`No se pudo bajar ${url}: ${String(lastError)}`);
}

/**
 * Igual que `fetchText` pero cachea en disco. Bajar ~1.150 páginas tarda 20
 * minutos; sin caché, cualquier corte obliga a empezar de cero y a re-pegarle
 * al sitio por algo que ya pedimos.
 */
async function fetchFicha(url: string, cacheKey: string): Promise<string> {
  const cacheFile = join(CACHE_DIR, `${cacheKey}.html`);
  try {
    return await readFile(cacheFile, 'utf8');
  } catch {
    // Cache miss: sigue.
  }
  const html = await fetchText(url);
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, html, 'utf8');
  await sleep(DELAY_MS);
  return html;
}

/**
 * Una ficha por modelo: la del año más nuevo.
 *
 * Las URLs son todas `/fichas-tecnicas/<marca>/<modelo>/<año>/<versión>`, y las
 * de Uruguay van bajo `/uy/fichas-tecnicas/...`.
 *
 * POR QUÉ LA FICHA URUGUAYA TAMBIÉN SIRVE
 *
 * Se prefiere siempre la argentina, pero 221 modelos sólo tienen ficha UY —y
 * entre ellos hay varios que acá se venden (BYD Song Plus, Tang, Han, Seal;
 * BMW Serie 4; Changan CS35 Plus). Lo único que este importador lee de la
 * página es la CARROCERÍA, que es una propiedad del auto y no cambia de un país
 * a otro. Descartarlas perdería modelos reales a cambio de nada.
 *
 * Y el costo de sobre-incluir es asimétrico: un modelo de más es una fila en un
 * autocompletado; un modelo de menos es un operador tipeando a mano.
 */
function pickOneFichaPerModel(urls: string[]): Map<string, string> {
  interface Candidate {
    year: number;
    url: string;
    /** La ficha AR le gana a la UY aunque la UY sea de un año más nuevo. */
    isArgentina: boolean;
  }
  const best = new Map<string, Candidate>();

  for (const url of urls) {
    const isArgentina = !url.includes('/uy/fichas-tecnicas/');
    const path = url.split('/fichas-tecnicas/')[1];
    if (!path) continue;
    const [brandSlug, modelSlug, yearRaw] = path.split('/');
    if (!brandSlug || !modelSlug || !yearRaw) continue;

    const year = Number(yearRaw);
    if (!Number.isInteger(year)) continue;

    const key = `${brandSlug}/${modelSlug}`;
    const current = best.get(key);
    const better =
      !current ||
      (isArgentina && !current.isArgentina) ||
      (isArgentina === current.isArgentina &&
        // Desempate por URL para que dos corridas den exactamente lo mismo.
        (year > current.year || (year === current.year && url < current.url)));

    if (better) best.set(key, { year, url, isArgentina });
  }

  return new Map([...best].map(([key, { url }]) => [key, url]));
}

/**
 * Marca y modelo display, del breadcrumb JSON-LD:
 *
 *   ['Inicio', 'Autos (Argentina)', 'Toyota', 'Hilux', 'SRV 3.0 TDI AT DC 4x4 2015']
 *                                    ^^^^^^^^  ^^^^^^^
 */
function extractNames(html: string): { brand: string; model: string } | null {
  const blocks = html.matchAll(
    /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g,
  );

  for (const [, raw] of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;

    const list = (parsed as { itemListElement?: { name?: unknown }[] }).itemListElement;
    if (!Array.isArray(list) || list.length < 4) continue;

    const brand = list[2]?.name;
    const model = list[3]?.name;
    if (typeof brand !== 'string' || typeof model !== 'string') continue;
    if (!brand.trim() || !model.trim()) continue;

    return { brand: brand.trim(), model: model.trim() };
  }

  return null;
}

/** `<th>Tipo de carrocería</th><td class="...">Pickup</td>` */
function extractCarroceria(html: string): string | null {
  const match = html.match(/Tipo de carrocer[íi]a<\/th>\s*<td[^>]*>([^<]+)</);
  return match ? match[1].trim() : null;
}

async function main(): Promise<void> {
  const { limit } = parseArgs(process.argv.slice(2));

  console.error('→ Bajando sitemaps…');
  const urls: string[] = [];
  for (const sitemap of SITEMAPS) {
    const xml = await fetchText(sitemap);
    for (const [, loc] of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.push(loc);
    await sleep(DELAY_MS);
  }

  const fichas = pickOneFichaPerModel(urls);
  console.error(`  ${urls.length} URLs → ${fichas.size} modelos argentinos`);

  const targets = [...fichas].sort(([a], [b]) => a.localeCompare(b));
  const selected = limit === null ? targets : targets.slice(0, limit);
  if (limit !== null) console.error(`  --limit ${limit}: se bajan ${selected.length}`);

  const entries: CatalogEntry[] = [];
  const noCarroceria: string[] = [];
  const noNames: string[] = [];
  const failed: string[] = [];

  let done = 0;
  for (const [key, url] of selected) {
    done++;
    if (done % 50 === 0 || done === selected.length) {
      console.error(`  ${done}/${selected.length}…`);
    }

    let html: string;
    try {
      html = await fetchFicha(url, key.replace('/', '__'));
    } catch (error) {
      failed.push(`${key}: ${String(error)}`);
      continue;
    }

    const names = extractNames(html);
    if (!names) {
      noNames.push(key);
      continue;
    }

    const carroceria = extractCarroceria(html);
    if (!carroceria) {
      noCarroceria.push(key);
      continue;
    }

    entries.push({ ...names, carroceria, source: url });
  }

  entries.sort((a, b) => a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model));

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');

  const byCarroceria = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.carroceria] = (acc[e.carroceria] ?? 0) + 1;
    return acc;
  }, {});

  console.error(`\n✓ ${entries.length} modelos → ${OUT_FILE}`);
  console.error(`  marcas: ${new Set(entries.map((e) => e.brand)).size}`);
  console.error('  carrocerías:');
  for (const [name, count] of Object.entries(byCarroceria).sort((a, b) => b[1] - a[1])) {
    console.error(`    ${String(count).padStart(5)}  ${name}`);
  }

  // Se reportan pero no se inventan: un modelo sin carrocería queda afuera del
  // JSON y, si hace falta, se tipifica a mano en MODEL_TYPES.
  for (const [label, list] of [
    ['sin carrocería', noCarroceria],
    ['sin breadcrumb', noNames],
    ['fallaron', failed],
  ] as const) {
    if (list.length > 0) {
      console.error(`\n⚠ ${list.length} ${label}:`);
      for (const item of list.slice(0, 20)) console.error(`    - ${item}`);
      if (list.length > 20) console.error(`    … y ${list.length - 20} más`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
