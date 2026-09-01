/**
 * Tipo de carrocería de cada modelo del catálogo semilla de la plataforma.
 *
 * POR QUÉ ESTE ARCHIVO EXISTE
 *
 * `vehicle-brands.ts` (y el `vehicleBrands.ts` del desktop del que salió) trae
 * marca y modelo, nada más: no existía ninguna fuente en el proyecto que supiera
 * que una Hilux es una pickup. Este mapa se construyó a mano, modelo por modelo,
 * contra el mercado argentino.
 *
 * DELIBERADAMENTE NO HAY DEFAULT. `gen-vehicle-catalog.ts` falla si un modelo de
 * `vehicle-brands.ts` no aparece acá. Un default (`auto`, o `null`) haría que
 * agregar modelos nuevos los tipifique mal en silencio, y como los globales son
 * read-only para los tenants, nadie podría corregirlos desde la app.
 *
 * CRITERIO (carrocería, el dato de origen):
 *   auto   - sedán, hatchback, coupé, familiar, monovolumen
 *   suv    - SUV y crossover, con o sin tracción integral
 *   pickup - caja de carga abierta
 *   van    - utilitario / furgón, con o sin ventanas
 *
 * Esto clasifica por CARROCERÍA y se mantiene fiel al dato real: una Kangoo es
 * una van. Lo que se SIEMBRA es otra cosa —el nombre de un tipo de la
 * plantilla— y sale de `TEMPLATE_TYPE_NAME`. Se conservan separados a propósito:
 * falsear la carrocería para que coincida con la plantilla sería mentir en la
 * fuente, y la información ya no se recupera.
 */
export type CatalogVehicleType = 'auto' | 'suv' | 'pickup' | 'van';

/**
 * Carrocería -> nombre del tipo por defecto con el que se siembra cada cuenta.
 *
 * `van -> Otro` es donde se reclasifican los 10 utilitarios (Kangoo, Partner,
 * Berlingo...). Los siete defaults no incluyen "Utilitario" A PROPÓSITO: es el
 * ejemplo canónico de la categoría que crea el dueño, y dejarlo afuera hace que
 * la feature se explique sola la primera vez que alguien la necesita.
 *
 * Si algún día "Utilitario" entrara como default, se cambia ESTA línea y los 10
 * se reclasifican solos.
 */
export const TEMPLATE_TYPE_NAME: Record<CatalogVehicleType, string> = {
  auto: 'Auto',
  suv: 'SUV',
  pickup: 'Pickup',
  van: 'Otro',
};

/**
 * Los siete tipos que siembra `vehicle_type_defaults`. Duplicado acá para que
 * el generador falle ANTES de emitir SQL si `TEMPLATE_TYPE_NAME` apunta a un
 * nombre que no existe. La FK a `vehicle_type_defaults(name)` es el backstop en
 * la base; esto avisa en el momento de generar.
 */
export const DEFAULT_TYPE_NAMES = [
  'Auto',
  'Moto',
  'Bici',
  'SUV',
  'Pickup',
  'Camión',
  'Otro',
] as const;

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
