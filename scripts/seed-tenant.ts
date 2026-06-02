// Local-only tenant business seed.
//
// Creates sample `entries` rows for two tenants using global `vehicles`.
// Idempotent — safe to run multiple times.
//
// Guardrails:
//   - Refuses to run unless SUPABASE_URL points to localhost / 127.0.0.1.
//   - Refuses to run without DATABASE_URL.
//   - Fails with a clear message if required tables are missing.
//
// Trigger: `make seed-tenant` or `bun run seed:tenant`.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
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
  once: '11111111-1111-1111-1111-111111111111',
  belgrano: '22222222-2222-2222-2222-222222222222',
} as const;

const VEHICLES = {
  corolla: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  ranger: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
  kangoo: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
} as const;

// Onboarding demo: two already-APPROVED entities (Once + Belgrano, owned by
// owner@example.com via memberships) carry legal data + payment methods, and one
// PENDING application under review (feeds the PARKIT Ops queue).
const PENDING_APPLICATION = 'dddddddd-dddd-dddd-dddd-ddddddddddd1';
const PENDING_DOCUMENT = 'dddddddd-dddd-dddd-dddd-ddddddddddc1';

type SeedEntry = {
  id: string;
  tenantId: string;
  vehicleId: string;
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
    vehicleId: VEHICLES.corolla,
    plate: 'AA123BB',
    color: 'Negro',
    enteredAt: '2026-05-01T10:05:00.000Z',
    leftAt: '2026-05-01T12:40:00.000Z',
    amountPaid: '3200.00',
  },
  {
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2',
    tenantId: TENANTS.once,
    vehicleId: VEHICLES.ranger,
    plate: 'AC987DE',
    color: 'Blanco',
    enteredAt: '2026-05-02T08:15:00.000Z',
  },
  {
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3',
    tenantId: TENANTS.belgrano,
    vehicleId: VEHICLES.kangoo,
    plate: 'AG456HI',
    color: 'Rojo',
    enteredAt: '2026-05-01T09:20:00.000Z',
    leftAt: '2026-05-01T11:00:00.000Z',
    amountPaid: '2700.00',
  },
  {
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee4',
    tenantId: TENANTS.belgrano,
    vehicleId: VEHICLES.corolla,
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

async function main(): Promise<void> {
  const required = ['tenants', 'vehicles', 'entries'];
  for (const table of required) {
    const exists = await tableExists(table);
    if (!exists) {
      throw new Error(
        `Missing table "${table}". Apply migrations first (make migration-apply).`,
      );
    }
  }

  await prisma.vehicle.upsert({
    where: { id: VEHICLES.corolla },
    create: {
      id: VEHICLES.corolla,
      brand: 'Toyota',
      model: 'Corolla',
      type: 'sedan',
    },
    update: { brand: 'Toyota', model: 'Corolla', type: 'sedan' },
  });
  await prisma.vehicle.upsert({
    where: { id: VEHICLES.ranger },
    create: {
      id: VEHICLES.ranger,
      brand: 'Ford',
      model: 'Ranger',
      type: 'pickup',
    },
    update: { brand: 'Ford', model: 'Ranger', type: 'pickup' },
  });
  await prisma.vehicle.upsert({
    where: { id: VEHICLES.kangoo },
    create: {
      id: VEHICLES.kangoo,
      brand: 'Renault',
      model: 'Kangoo',
      type: 'van',
    },
    update: { brand: 'Renault', model: 'Kangoo', type: 'van' },
  });

  for (const entry of ENTRIES) {
    await prisma.entry.upsert({
      where: { id: entry.id },
      create: {
        id: entry.id,
        tenantId: entry.tenantId,
        vehicleId: entry.vehicleId,
        plate: entry.plate,
        color: entry.color ?? null,
        enteredAt: new Date(entry.enteredAt),
        leftAt: entry.leftAt ? new Date(entry.leftAt) : null,
        amountPaid: entry.amountPaid ?? null,
      },
      update: {
        tenantId: entry.tenantId,
        vehicleId: entry.vehicleId,
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
  // Per-type spot capacity now lives in `tenant.settings.capacity` (the `zones`
  // table was removed). It feeds the owner dashboard occupancy and config.
  await prisma.tenant.update({
    where: { id: TENANTS.once },
    data: {
      legalName: 'Estacionamientos Centro SA',
      cuit: '30700000001',
      email: 'centro@parkit.test',
      phone: '+541140000000',
      address: 'Bartolomé Mitre 2500, CABA',
      status: 'active',
      settings: {
        capacity: { carSpots: 40, motorcycleSpots: 10, bicycleSpots: 5 },
      },
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
      settings: {
        capacity: { carSpots: 25, motorcycleSpots: 8, bicycleSpots: 0 },
      },
    },
  });

  for (const tenantId of [TENANTS.once, TENANTS.belgrano]) {
    for (const [type, name, isDefault] of [
      ['mp_transfer', 'Bank transfer (Mercado Pago)', true],
      ['cash', 'Cash', false],
    ] as const) {
      await prisma.paymentMethod.upsert({
        where: { tenantId_type: { tenantId, type } },
        create: {
          tenantId,
          type,
          name,
          enabled: true,
          isSystem: true,
          isDefault,
        },
        update: { name, isSystem: true },
      });
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
