// Local-only tenant business seed.
//
// Creates sample `rates` and `entries` rows for two tenants using global
// `vehicles`. Idempotent — safe to run multiple times.
//
// Guardrails:
//   - Refuses to run unless SUPABASE_URL points to localhost / 127.0.0.1.
//   - Refuses to run without DATABASE_URL.
//   - Fails with a clear message if required tables are missing.
//
// Trigger: `make seed-tenant` or `bun run seed:tenant`.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type ServiceCode } from '@prisma/client';
import { Pool } from 'pg';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const DATABASE_URL = process.env.DATABASE_URL ?? '';

if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(SUPABASE_URL)) {
  console.error('✗ Refusing to seed tenant data: SUPABASE_URL is not local.');
  console.error(`  SUPABASE_URL=${SUPABASE_URL || '(unset)'}`);
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('✗ Missing DATABASE_URL in env.');
  process.exit(1);
}

const TENANTS = {
  once: '11111111-1111-4111-8111-111111111111',
  belgrano: '22222222-2222-4222-8222-222222222222',
} as const;

// Vehículos PROPIOS de cada estacionamiento. Los globales (244 modelos) los
// aplica la migración 20260831190200_vehicles_global_catalog_seed.sql, no un
// seed: `supabase/seed.sql` nunca llega a la nube y producción quedaría con el
// catálogo vacío.
//
// Antes acá se re-upserteaban los 3 globales del seed viejo. Eso disparaba el
// trigger en cada `make seed-all` y les rotaba `sync_seq`/`version` al pedo.
type SeedVehicle = {
  id: string;
  tenantId: string;
  brand: string;
  model: string;
  /** Nombre del tipo en `vehicle_types` de ESE tenant; se resuelve a `typeId`. */
  typeName: string;
  /** Sembrado ya borrado, para ejercitar el tombstone del sync. */
  deleted?: boolean;
};

/**
 * Tipo propio de demo. "Utilitario" NO está entre los siete defaults a
 * propósito: es el ejemplo canónico de la categoría que crea el dueño. Que Once
 * lo tenga hace que el seed DEMUESTRE la feature en vez de contradecirla — y le
 * da al Iveco Daily una clasificación honesta en vez de mandarlo a "Otro".
 */
const TENANT_VEHICLE_TYPES = [
  {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaacc1',
    tenantId: TENANTS.once,
    name: 'Utilitario',
    accepted: true,
  },
];

const TENANT_VEHICLES: SeedVehicle[] = [
  {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaabb1',
    tenantId: TENANTS.once,
    brand: 'Iveco',
    model: 'Daily',
    typeName: 'Utilitario',
  },
  {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaabb2',
    tenantId: TENANTS.once,
    brand: 'Zanella',
    model: 'RX 150',
    typeName: 'Moto',
  },
  {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaabb3',
    tenantId: TENANTS.belgrano,
    brand: 'Agrale',
    model: 'Marruá',
    typeName: 'Pickup',
  },
  {
    // Tombstone a propósito: ejercita que una baja llegue a los clientes
    // offline por /vehicles/changes. Mismo criterio que las tasas borradas.
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaabb4',
    tenantId: TENANTS.once,
    brand: 'Corven',
    model: 'Energy',
    typeName: 'Moto',
    deleted: true,
  },
];

// Onboarding demo: two already-APPROVED entities (Once + Belgrano, owned by
// owner@example.com via memberships) carry legal data + payment methods, and one
// PENDING application under review (feeds the PARKIT Ops queue).
const PENDING_APPLICATION = 'dddddddd-dddd-dddd-dddd-ddddddddddd1';
const PENDING_DOCUMENT = 'dddddddd-dddd-dddd-dddd-ddddddddddc1';

// Rates were missing from this seed, so `make reset && make seed-all` left the
// table empty and both the web ABM and the desktop panel came up with no
// tariffs — which reads as a persistence bug rather than an empty seed.
//
// The non-round prices are deliberate: they exercise ARS formatting and the
// Decimal(12,2) precision path, where round numbers would hide bugs.
type SeedRate = {
  id: string;
  tenantId: string;
  name: string;
  hourPriceArs: string;
  stayPriceArs: string;
  fractionPriceArs: string;
  shortcutNumber: number;
  isActive?: boolean;
  /** Set to seed a soft-deleted rate (tombstone) — see RATES below. */
  deleted?: boolean;
};

const RATES: SeedRate[] = [
  {
    id: 'ffffffff-ffff-ffff-ffff-fffffffffff1',
    tenantId: TENANTS.once,
    name: 'DIA AUTO ONCE',
    hourPriceArs: '4444.44',
    stayPriceArs: '8000.00',
    fractionPriceArs: '300.00',
    shortcutNumber: 1,
  },
  // Deactivated, not deleted: the owner panel still lists it and can reactivate
  // it. Keeps the isActive/deletedAt distinction visible in a fresh environment.
  {
    id: 'ffffffff-ffff-ffff-ffff-fffffffffff2',
    tenantId: TENANTS.once,
    name: 'NOCHE MOTO ONCE',
    hourPriceArs: '1800.50',
    stayPriceArs: '4000.00',
    fractionPriceArs: '150.00',
    shortcutNumber: 2,
    isActive: false,
  },
  // Soft-deleted: never returned by GET /rates, but shipped by
  // GET /rates/changes as a tombstone. Its shortcut number stays reusable
  // because the unique index is scoped to `deleted_at IS NULL`.
  {
    id: 'ffffffff-ffff-ffff-ffff-fffffffffff3',
    tenantId: TENANTS.once,
    name: 'TASA BORRADA (DEMO)',
    hourPriceArs: '999.99',
    stayPriceArs: '2500.00',
    fractionPriceArs: '99.00',
    shortcutNumber: 9,
    deleted: true,
  },
  {
    id: 'ffffffff-ffff-ffff-ffff-fffffffffff4',
    tenantId: TENANTS.belgrano,
    name: 'TARIFA BELGRANO',
    hourPriceArs: '5000.00',
    stayPriceArs: '12000.00',
    fractionPriceArs: '500.00',
    shortcutNumber: 1,
  },
];

// Entries no longer hold a vehicle FK: the model snapshots brand/model inline
// (offline-first denormalization). The Vehicle catalog stays for autocomplete.
type SeedEntry = {
  id: string;
  tenantId: string;
  vehicleBrand: string;
  vehicleModel: string;
  plate: string;
  color?: string;
  enteredAt: string;
  leftAt?: string;
  amountPaid?: string;
};

const ENTRIES: SeedEntry[] = [
  {
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1',
    tenantId: TENANTS.once,
    vehicleBrand: 'Toyota',
    vehicleModel: 'Corolla',
    plate: 'AA123BB',
    color: 'Negro',
    enteredAt: '2026-05-01T10:05:00.000Z',
    leftAt: '2026-05-01T12:40:00.000Z',
    amountPaid: '3200.00',
  },
  {
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2',
    tenantId: TENANTS.once,
    vehicleBrand: 'Ford',
    vehicleModel: 'Ranger',
    plate: 'AC987DE',
    color: 'Blanco',
    enteredAt: '2026-05-02T08:15:00.000Z',
  },
  {
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3',
    tenantId: TENANTS.belgrano,
    vehicleBrand: 'Renault',
    vehicleModel: 'Kangoo',
    plate: 'AG456HI',
    color: 'Rojo',
    enteredAt: '2026-05-01T09:20:00.000Z',
    leftAt: '2026-05-01T11:00:00.000Z',
    amountPaid: '2700.00',
  },
  {
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee4',
    tenantId: TENANTS.belgrano,
    vehicleBrand: 'Toyota',
    vehicleModel: 'Corolla',
    plate: 'AJ741KL',
    color: 'Azul',
    enteredAt: '2026-05-03T14:00:00.000Z',
  },
];

const pool = new Pool({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function tableExists(table: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
    `SELECT to_regclass('public.${table}') IS NOT NULL AS exists`,
  );
  return rows[0]?.exists === true;
}

/** Fixed so re-seeding writes the same value instead of a moving timestamp. */
const DEMO_DELETED_AT = new Date('2026-05-04T18:00:00.000Z');

/**
 * Vehículos propios de cada estacionamiento (idempotente, ids fijos).
 *
 * Antes ningún seed creaba vehículos de tenant ni bajas, así que el ABM y el
 * camino de tombstones del sync arrancaban sin fixtures.
 *
 * `syncSeq` nunca se pasa: la columna tiene DEFAULT nextval('vehicles_sync_seq')
 * y un valor explícito caería en 0, invisible para /vehicles/changes.
 */
async function seedTenantVehicles(): Promise<void> {
  let seeded = 0;

  // El tipo propio de demo va primero: los vehículos lo referencian por FK.
  for (const type of TENANT_VEHICLE_TYPES) {
    await prisma.vehicleType.upsert({
      where: { id: type.id },
      create: type,
      update: { name: type.name, accepted: type.accepted },
    });
  }

  for (const vehicle of TENANT_VEHICLES) {
    // Los siete tipos por defecto los siembra el trigger de `tenants`; acá se
    // resuelve el nombre al id de ESE estacionamiento.
    const type = await prisma.vehicleType.findFirst({
      where: {
        tenantId: vehicle.tenantId,
        name: vehicle.typeName,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!type) {
      console.warn(
        `⚠ Skipped vehicle "${vehicle.brand} ${vehicle.model}": no existe el tipo "${vehicle.typeName}" en ese estacionamiento.`,
      );
      continue;
    }

    const fields = {
      tenantId: vehicle.tenantId,
      brand: vehicle.brand,
      model: vehicle.model,
      typeId: type.id,
      deletedAt: vehicle.deleted ? DEMO_DELETED_AT : null,
    };

    try {
      await prisma.vehicle.upsert({
        where: { id: vehicle.id },
        create: { id: vehicle.id, ...fields },
        update: fields,
      });
      seeded += 1;
    } catch (error) {
      // `vehicles_tenant_brand_model_uidx` es parcial sobre `deleted_at IS NULL`,
      // así que una fila viva cargada a mano con la misma marca/modelo colisiona.
      // Se saltea con un mensaje claro en vez de voltear todo `make seed-all`.
      const code = (error as { code?: string }).code;
      if (code !== 'P2002') throw error;
      console.warn(
        `⚠ Skipped vehicle "${vehicle.brand} ${vehicle.model}": already taken in this tenant.`,
      );
    }
  }

  const tombstones = TENANT_VEHICLES.filter((v) => v.deleted).length;
  console.log(
    `✓ Seeded ${seeded} tenant vehicles across 2 tenants (${tombstones} soft-deleted, for tombstone sync).`,
  );
}

/**
 * Rates seed (idempotent, keyed by fixed ids).
 *
 * `syncSeq` is never passed: the column defaults to `nextval('rates_sync_seq')`
 * and an explicit value would land as 0, which is invisible to `/rates/changes`
 * (that's what 20260604024720_fix_sync_seq_zero.sql had to repair).
 */
async function seedRates(): Promise<void> {
  let seeded = 0;

  for (const rate of RATES) {
    const fields = {
      tenantId: rate.tenantId,
      name: rate.name,
      hourPriceArs: rate.hourPriceArs,
      stayPriceArs: rate.stayPriceArs,
      fractionPriceArs: rate.fractionPriceArs,
      shortcutNumber: rate.shortcutNumber,
      isActive: rate.isActive ?? true,
      deletedAt: rate.deleted ? DEMO_DELETED_AT : null,
    };

    try {
      await prisma.rate.upsert({
        where: { id: rate.id },
        create: { id: rate.id, ...fields },
        update: fields,
      });
      seeded += 1;
    } catch (error) {
      // The partial unique index on (tenant_id, shortcut_number) is scoped to
      // `deleted_at IS NULL`, so a hand-made live rate holding the same
      // shortcut collides. Skip it with a clear message instead of aborting
      // the whole `make seed-all`.
      const code = (error as { code?: string }).code;
      if (code !== 'P2002') throw error;
      console.warn(
        `⚠ Skipped rate "${rate.name}": shortcut ${rate.shortcutNumber} is already taken in this tenant by another rate.`,
      );
    }
  }

  const tombstones = RATES.filter((r) => r.deleted).length;
  console.log(
    `✓ Seeded ${seeded} rates across 2 tenants (${tombstones} soft-deleted, for tombstone sync).`,
  );
}

async function main(): Promise<void> {
  const required = ['tenants', 'vehicles', 'entries', 'rates'];
  for (const table of required) {
    const exists = await tableExists(table);
    if (!exists) {
      throw new Error(
        `Missing table "${table}". Apply migrations first (make migration-apply).`,
      );
    }
  }

  await seedTenantVehicles();

  await seedRates();

  for (const entry of ENTRIES) {
    await prisma.entry.upsert({
      where: { id: entry.id },
      create: {
        id: entry.id,
        tenantId: entry.tenantId,
        vehicleBrand: entry.vehicleBrand,
        vehicleModel: entry.vehicleModel,
        plate: entry.plate,
        color: entry.color ?? null,
        enteredAt: new Date(entry.enteredAt),
        leftAt: entry.leftAt ? new Date(entry.leftAt) : null,
        amountPaid: entry.amountPaid ?? null,
      },
      update: {
        tenantId: entry.tenantId,
        vehicleBrand: entry.vehicleBrand,
        vehicleModel: entry.vehicleModel,
        plate: entry.plate,
        color: entry.color ?? null,
        enteredAt: new Date(entry.enteredAt),
        leftAt: entry.leftAt ? new Date(entry.leftAt) : null,
        amountPaid: entry.amountPaid ?? null,
      },
    });
  }

  console.log(
    `✓ Seeded ${ENTRIES.length} tenant-local entries across 2 tenants.`,
  );

  await seedOnboarding();
}

/**
 * Onboarding-flow seed (idempotent). Requires `seed-auth` to have run first
 * (needs the users owner@example.com and owner-pending@example.com).
 * Runs as part of `make seed-all` (seed-global -> seed-auth -> seed-tenant).
 */
async function seedOnboarding(): Promise<void> {
  const onboardingTables = [
    'onboarding_applications',
    'application_documents',
    'payment_methods',
  ];
  for (const table of onboardingTables) {
    if (!(await tableExists(table))) {
      console.warn(`⚠ Skipping onboarding seed: missing table "${table}".`);
      return;
    }
  }

  const owner = await prisma.user.findFirst({
    where: { email: 'owner@example.com' },
  });
  const ownerPending = await prisma.user.findFirst({
    where: { email: 'owner-pending@example.com' },
  });
  if (!owner || !ownerPending) {
    console.warn('⚠ Skipping onboarding seed: run `make seed-auth` first.');
    return;
  }

  // --- APPROVED entities: Once + Belgrano (owned by owner@example.com) ---
  // Membership is seeded by seed-auth; here we fill the relocated legal/contact
  // data and the entity-level payment methods.
  // La capacidad total vive en `tenant.settings.capacity.total`: un solo
  // número. Alimenta la ocupación del dashboard y la pantalla de config.
  await prisma.tenant.update({
    where: { id: TENANTS.once },
    data: {
      legalName: 'Estacionamientos Centro SA',
      cuit: '30700000001',
      email: 'centro@parkit.test',
      phone: '+541140000000',
      address: 'Bartolomé Mitre 2500, CABA',
      status: 'active',
      settings: { capacity: { total: 55 } },
    },
  });
  await prisma.tenant.update({
    where: { id: TENANTS.belgrano },
    data: {
      legalName: 'Estacionamientos Centro SA',
      cuit: '30700000001',
      email: 'centro@parkit.test',
      phone: '+541140000000',
      address: 'Av. Cabildo 2000, CABA',
      status: 'active',
      settings: { capacity: { total: 33 } },
    },
  });

  // Servicios: sólo amenities. Los códigos VEHICLE_* se retiraron — "qué
  // vehículos acepta la playa" vive en `vehicle_types.accepted`, y las plazas
  // en `tenant.settings.capacity.total`.
  const demoServices: Record<string, { code: string; enabled: boolean }[]> = {
    [TENANTS.once]: [{ code: 'ADVANCE_RESERVATION', enabled: true }],
    [TENANTS.belgrano]: [{ code: 'ADVANCE_RESERVATION', enabled: false }],
  };
  for (const [tenantId, rows] of Object.entries(demoServices)) {
    for (const r of rows) {
      await prisma.service.upsert({
        where: { tenantId_code: { tenantId, code: r.code as ServiceCode } },
        create: {
          tenantId,
          code: r.code as ServiceCode,
          enabled: r.enabled,
        },
        update: { enabled: r.enabled },
      });
    }
  }

  // System payment methods are unique per (tenantId, type) only through a
  // *partial* unique index (WHERE is_system = true), which Prisma cannot target
  // in an upsert. Seed them idempotently with findFirst + create/update.
  for (const tenantId of [TENANTS.once, TENANTS.belgrano]) {
    // Generic, owner-editable defaults: no brand names baked in.
    for (const [type, name, isDefault] of [
      ['transfer', 'transfer', true],
      ['cash', 'cash', false],
    ] as const) {
      const existing = await prisma.paymentMethod.findFirst({
        where: { tenantId, type, isSystem: true },
      });
      if (existing) {
        await prisma.paymentMethod.update({
          where: { id: existing.id },
          data: { name, isSystem: true },
        });
      } else {
        await prisma.paymentMethod.create({
          data: {
            tenantId,
            type,
            name,
            enabled: true,
            isSystem: true,
            isDefault,
          },
        });
      }
    }
  }

  // --- PENDING application: one entity under review (PARKIT Ops queue) ---
  // Belongs to the applicant (owner-pending, a plain user). On approval it
  // materializes a tenant + grants the applicant an owner membership.
  await prisma.onboardingApplication.upsert({
    where: { id: PENDING_APPLICATION },
    create: {
      id: PENDING_APPLICATION,
      applicantUserId: ownerPending.id,
      status: 'pending_review',
      submittedAt: new Date('2026-05-20T12:00:00.000Z'),
      declaredEntity: {
        name: 'Caballito lot',
        address: 'Av. Rivadavia 5000, CABA',
        legalName: 'Cocheras del Sur SRL',
        cuit: '30700000002',
        email: 'sur@parkit.test',
        phone: '+541150000000',
        carSpots: 30,
        motorcycleSpots: 10,
        bicycleSpots: 5,
      },
    },
    update: { status: 'pending_review', applicantUserId: ownerPending.id },
  });

  await prisma.applicationDocument.upsert({
    where: { id: PENDING_DOCUMENT },
    create: {
      id: PENDING_DOCUMENT,
      applicationId: PENDING_APPLICATION,
      name: 'Articles of incorporation.pdf',
      storagePath: 'demo/cocheras-del-sur/estatuto.pdf',
      mimeType: 'application/pdf',
    },
    update: {},
  });

  console.log(
    '✓ Seeded onboarding: 2 active entities (Once+Belgrano) and 1 pending application.',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
