import type { VehicleCategory } from '../../src/vehicle-categories/vehicle-categories';

/**
 * Tipo de carrocería de cada modelo del catálogo semilla de la plataforma.
 *
 * POR QUÉ ESTE ARCHIVO EXISTE
 *
 * `vehicle-brands.ts` (y el `vehicleBrands.ts` del desktop del que salió) trae
 * marca y modelo, nada más: no existía ninguna fuente en el proyecto que supiera
 * que una Hilux es una pickup. `MODEL_TYPES` se construyó a mano, modelo por
 * modelo, contra el mercado argentino.
 *
 * DE DÓNDE SALE EL TIPO AHORA
 *
 * Desde el backfill del catálogo, el grueso de los modelos lo aporta
 * `vehicle-catalog.json` (importado con `make catalog-import`), que ya trae la
 * carrocería publicada por la fuente. `CARROCERIA_TO_TYPE` la traduce.
 *
 * `MODEL_TYPES` dejó de ser el catálogo entero y pasó a ser la CAPA DE
 * OVERRIDES: lo que está acá gana siempre. Sirve para los modelos curados que
 * la fuente no tiene (T-Cross, Great Wall, Lifan) y para corregirle la mano
 * cuando clasifica distinto a como opera una playa.
 *
 * Orden de resolución en `gen-vehicle-catalog.ts`:
 *
 *   1. MODEL_TYPES[marca][modelo]          ← el override curado
 *   2. CARROCERIA_TO_TYPE[carrocería]      ← el bulk importado
 *   3. throw
 *
 * DELIBERADAMENTE NO HAY DEFAULT EN NINGUNO DE LOS DOS PASOS. Un default
 * (`auto`, o `null`) haría que agregar modelos nuevos los tipifique mal en
 * silencio, y como los globales son read-only para los tenants, nadie podría
 * corregirlos desde la app. Es preferible un generador que no corre.
 *
 * CRITERIO (carrocería, el dato de origen):
 *   auto   - sedán, hatchback, coupé, familiar, monovolumen
 *   suv    - SUV y crossover, con o sin tracción integral
 *   pickup - caja de carga abierta
 *   van    - utilitario / furgón, con o sin ventanas
 *
 * Esto clasifica por CARROCERÍA y se mantiene fiel al dato real: una Kangoo es
 * una van. Lo que se SIEMBRA es otra cosa —la categoría de la plataforma
 * (`vehicle_categories.code`)— y sale de `TEMPLATE_CATEGORY`. Hoy coinciden uno
 * a uno, pero se conservan separados a propósito: la carrocería es el dato de
 * la fuente y la categoría es una decisión nuestra que puede cambiar.
 */
export type CatalogVehicleType = 'auto' | 'suv' | 'pickup' | 'van';

/**
 * Carrocería publicada por la fuente -> nuestra clasificación.
 *
 * Las claves son los valores literales del campo "Tipo de carrocería" de
 * thecarsbase, tal como los escribe (con acentos). Los once confirmados salieron
 * de muestrear 87 modelos; `Familiar` se incluye porque el criterio de arriba ya
 * lo nombra, aunque no haya aparecido en la muestra.
 *
 * SIN DEFAULT, igual que `MODEL_TYPES`: si la fuente publica una carrocería que
 * no está acá, `gen-vehicle-catalog.ts` falla y la lista. Agregar la clave es
 * una línea; descubrir seis meses después que 40 modelos entraron como `auto`
 * porque hubo un `?? 'auto'` no se arregla con una línea.
 *
 * `Chasis` (Jumper, Transit chasis cabina) va a `van` y no a `pickup`: no tiene
 * caja de carga abierta, es un utilitario al que se le monta una carrocería.
 */
/**
 * Carrocerías que se descartan del catálogo a propósito.
 *
 * El alcance del catálogo son AUTOS. La fuente mete diez camiones livianos
 * (Foton Aumark, JMC N900, Kia Bongo…) dentro del dataset de autos; no son lo
 * que estaciona en una playa y no justifican sembrarle a cada cuenta diez
 * modelos que nadie va a tipear. Una playa que reciba uno lo carga a mano.
 *
 * ESTO NO ES UN ESCAPE PARA CARROCERÍAS NUEVAS. Excluir es una decisión
 * explícita que se toma acá; lo que NO esté ni en este array ni en
 * `CARROCERIA_TO_TYPE` sigue haciendo fallar al generador. La diferencia entre
 * "decidimos que no va" y "no sabemos qué es" tiene que seguir siendo visible.
 *
 * Si algún día entran los camiones de verdad, el camino es la sitemap de
 * camiones (21 modelos) + `camion` en `CatalogVehicleType`, no sacar esta línea.
 */
export const EXCLUDED_CARROCERIAS: readonly string[] = ['Camión liviano'];

/**
 * Fichas sueltas que se descartan, por slug `marca/modelo` de la URL de origen.
 *
 * POR QUÉ POR SLUG Y NO POR NOMBRE
 *
 * Estos existen justamente porque DOS fichas distintas comparten el mismo
 * nombre display. `('Chevrolet', 'Sonic')` no alcanza para decir cuál de las dos
 * se va; el slug sí, y además es lo que la fuente usa como identidad.
 *
 * POR QUÉ ACÁ Y NO BORRANDO LA FILA DEL JSON
 *
 * `vehicle-catalog.json` lo reescribe entero `make catalog-import`. Una fila
 * borrada a mano vuelve en la próxima importación y nadie se entera. Esto
 * sobrevive.
 *
 * El generador FALLA si alguno de estos slugs no aparece en el import: un slug
 * que no matchea es una exclusión que no se aplica, y el modelo que creíamos
 * afuera termina adentro.
 */
export const EXCLUDED_MODELS: readonly string[] = [
  // El sitio tiene el sedán 2016 (`chevrolet/sonic`) y un SUV 2026 con el mismo
  // nombre. La PK (brand, model) de vehicle_catalog_defaults no admite los dos,
  // y para un autocompletado "Chevrolet Sonic" es una sola entrada.
  'chevrolet/sonic-suv',
  // Acá el Corsa es Chevrolet, y `chevrolet/corsa` ya está en el catálogo.
  'opel/corsa',
  'opel/corsa-f',
];

export const CARROCERIA_TO_TYPE: Record<string, CatalogVehicleType> = {
  Sedán: 'auto',
  Hatchback: 'auto',
  Coupé: 'auto',
  Familiar: 'auto',
  Rural: 'auto',
  Monovolumen: 'auto',
  Microcar: 'auto',
  Cabrio: 'auto',
  Roadster: 'auto',
  SUV: 'suv',
  Pickup: 'pickup',
  // La fuente escribe las dos grafías. Son la misma carrocería.
  'Pick-up': 'pickup',
  Furgón: 'van',
  Van: 'van',
  Chasis: 'van',
};

/**
 * Carrocería -> categoría de la plataforma con la que se siembra el modelo.
 *
 * Desde la migración 20261005120100 la plantilla apunta a una CATEGORÍA y no al
 * nombre de un tipo: el trigger de alta de cuentas cuelga cada modelo del tipo
 * vivo más antiguo de esa categoría. Por eso los utilitarios (Kangoo, Partner,
 * Berlingo, furgones y chasis) son `van` y ya no hay que mandarlos a "Otro".
 *
 * El generador valida cada categoría contra `VEHICLE_CATEGORIES`
 * (src/vehicle-categories), que a su vez un spec compara con la migración.
 */
export const TEMPLATE_CATEGORY: Record<CatalogVehicleType, VehicleCategory> = {
  auto: 'car',
  suv: 'suv',
  pickup: 'pickup',
  van: 'van',
};

/**
 * Overrides curados: marca -> modelo -> tipo. Le ganan siempre a la carrocería
 * importada.
 *
 * No hace falta que estén los ~1.150 modelos del JSON. Lo que va acá es lo que
 * la fuente no sabe o sabe distinto. No es obligatorio que un modelo figure:
 * si no está, se resuelve por `CARROCERIA_TO_TYPE`.
 *
 * Lo que SÍ es obligatorio es que todo lo que esté acá exista en el catálogo
 * final (`vehicle-brands.ts` ∪ `vehicle-catalog.json`). El generador falla con
 * los huérfanos: una clasificación que no le corresponde a ningún modelo es casi
 * siempre un typo en el nombre.
 */
export const MODEL_TYPES: Record<string, Record<string, CatalogVehicleType>> = {
  Volkswagen: {
    Gol: 'auto',
    Golf: 'auto',
    Polo: 'auto',
    Bora: 'auto',
    Vento: 'auto',
    Suran: 'auto',
    Saveiro: 'pickup',
    Fox: 'auto',
    Amarok: 'pickup',
    Tiguan: 'suv',
    'T-Cross': 'suv',
    Virtus: 'auto',
    Taos: 'suv',
    Nivus: 'suv',
    Up: 'auto',
  },
  Ford: {
    Fiesta: 'auto',
    Focus: 'auto',
    Ka: 'auto',
    EcoSport: 'suv',
    Kuga: 'suv',
    Ranger: 'pickup',
    Mondeo: 'auto',
    Fusion: 'auto',
    Expedition: 'suv',
    Bronco: 'suv',
    Territory: 'suv',
    'Bronco Sport': 'suv',
  },
  Chevrolet: {
    Onix: 'auto',
    Cruze: 'auto',
    Tracker: 'suv',
    Equinox: 'suv',
    Spin: 'auto',
    Prisma: 'auto',
    Montana: 'pickup',
    S10: 'pickup',
    Corsa: 'auto',
    Agile: 'auto',
    Cobalt: 'auto',
    Sail: 'auto',
  },
  Renault: {
    Kangoo: 'van',
    Sandero: 'auto',
    Logan: 'auto',
    Duster: 'suv',
    Kwid: 'auto',
    Oroch: 'pickup',
    Captur: 'suv',
    Megane: 'auto',
    Symbol: 'auto',
    Clio: 'auto',
    Fluence: 'auto',
  },
  Fiat: {
    Palio: 'auto',
    Siena: 'auto',
    Uno: 'auto',
    Punto: 'auto',
    Cronos: 'auto',
    Argo: 'auto',
    Toro: 'pickup',
    Pulse: 'suv',
    Mobi: 'auto',
    Strada: 'pickup',
    Fiorino: 'van',
    '500': 'auto',
  },
  Toyota: {
    Corolla: 'auto',
    Yaris: 'auto',
    Hilux: 'pickup',
    SW4: 'suv',
    RAV4: 'suv',
    'Land Cruiser': 'suv',
    Etios: 'auto',
    Camry: 'auto',
    Fortuner: 'suv',
    'C-HR': 'suv',
    GR86: 'auto',
  },
  Honda: {
    Civic: 'auto',
    Fit: 'auto',
    'HR-V': 'suv',
    'CR-V': 'suv',
    'WR-V': 'suv',
    City: 'auto',
    Jazz: 'auto',
    Accord: 'auto',
    Pilot: 'suv',
    Ridgeline: 'pickup',
  },
  Peugeot: {
    '208': 'auto',
    '308': 'auto',
    '408': 'auto',
    '2008': 'suv',
    '3008': 'suv',
    '5008': 'suv',
    Partner: 'van',
    Expert: 'van',
    '107': 'auto',
    '206': 'auto',
    '207': 'auto',
    '301': 'auto',
    '307': 'auto',
    '308 SW': 'auto',
  },
  Citroën: {
    C3: 'auto',
    C4: 'auto',
    C5: 'auto',
    'C3 Aircross': 'suv',
    Berlingo: 'van',
    Jumper: 'van',
    Jumpy: 'van',
    Picasso: 'auto',
    'C-Elysée': 'auto',
  },
  Nissan: {
    March: 'auto',
    Versa: 'auto',
    Sentra: 'auto',
    Tiida: 'auto',
    Frontier: 'pickup',
    'X-Trail': 'suv',
    Kicks: 'suv',
    Qashqai: 'suv',
    Navara: 'pickup',
    Patrol: 'suv',
  },
  Hyundai: {
    HB20: 'auto',
    i10: 'auto',
    i20: 'auto',
    i30: 'auto',
    Tucson: 'suv',
    'Santa Fe': 'suv',
    Creta: 'suv',
    Elantra: 'auto',
    Accent: 'auto',
    Veloster: 'auto',
  },
  Kia: {
    Picanto: 'auto',
    Rio: 'auto',
    Cerato: 'auto',
    Sportage: 'suv',
    Sorento: 'suv',
    Soul: 'suv',
    Stinger: 'auto',
    Seltos: 'suv',
    Carnival: 'van',
  },
  Jeep: {
    Renegade: 'suv',
    Compass: 'suv',
    Cherokee: 'suv',
    'Grand Cherokee': 'suv',
    Wrangler: 'suv',
    Gladiator: 'pickup',
  },
  Audi: {
    A1: 'auto',
    A3: 'auto',
    A4: 'auto',
    A5: 'auto',
    A6: 'auto',
    A7: 'auto',
    A8: 'auto',
    Q2: 'suv',
    Q3: 'suv',
    Q5: 'suv',
    Q7: 'suv',
    Q8: 'suv',
    TT: 'auto',
    RS3: 'auto',
    RS5: 'auto',
  },
  BMW: {
    '116i': 'auto',
    '118i': 'auto',
    '120i': 'auto',
    '316i': 'auto',
    '318i': 'auto',
    '320i': 'auto',
    '330i': 'auto',
    X1: 'suv',
    X2: 'suv',
    X3: 'suv',
    X4: 'suv',
    X5: 'suv',
    X6: 'suv',
    M3: 'auto',
    M5: 'auto',
  },
  'Mercedes-Benz': {
    'Clase A': 'auto',
    'Clase C': 'auto',
    'Clase E': 'auto',
    'Clase S': 'auto',
    GLA: 'suv',
    GLB: 'suv',
    GLC: 'suv',
    GLE: 'suv',
    GLS: 'suv',
    Sprinter: 'van',
    Vito: 'van',
  },
  Subaru: {
    Impreza: 'auto',
    Legacy: 'auto',
    Outback: 'suv',
    Forester: 'suv',
    XV: 'suv',
    WRX: 'auto',
    BRZ: 'auto',
  },
  Mitsubishi: {
    L200: 'pickup',
    Outlander: 'suv',
    'Eclipse Cross': 'suv',
    ASX: 'suv',
    Pajero: 'suv',
    Lancer: 'auto',
  },
  Mazda: {
    '2': 'auto',
    '3': 'auto',
    '6': 'auto',
    'CX-3': 'suv',
    'CX-5': 'suv',
    'CX-30': 'suv',
    'MX-5': 'auto',
  },
  Dodge: {
    Ram: 'pickup',
    Durango: 'suv',
    Challenger: 'auto',
    Charger: 'auto',
    Journey: 'suv',
  },
  Ram: {
    '700': 'pickup',
    '1500': 'pickup',
    '2500': 'pickup',
    '3500': 'pickup',
  },
  Suzuki: {
    Swift: 'auto',
    Vitara: 'suv',
    'S-Cross': 'suv',
    Jimny: 'suv',
    Baleno: 'auto',
    Ignis: 'suv',
  },
  Chery: {
    'Tiggo 2': 'suv',
    'Tiggo 3': 'suv',
    'Tiggo 4': 'suv',
    'Tiggo 7': 'suv',
    'Tiggo 8': 'suv',
    'Arrizo 5': 'auto',
    QQ: 'auto',
  },
  Geely: {
    Emgrand: 'auto',
    Coolray: 'suv',
    Okavango: 'suv',
    'GX3 Pro': 'suv',
  },
  BYD: {
    Dolphin: 'auto',
    'Atto 3': 'suv',
    Han: 'auto',
    Tang: 'suv',
    'Song Pro': 'suv',
    'Yuan Pro': 'suv',
  },
  'Great Wall': {
    Wingle: 'pickup',
    Poer: 'pickup',
    'Haval H6': 'suv',
    'Haval Jolion': 'suv',
  },
  Lifan: {
    '520': 'auto',
    '620': 'auto',
    '720': 'auto',
    X50: 'suv',
    X60: 'suv',
    X70: 'suv',
  },
};
