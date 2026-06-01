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

// Onboarding demo: one already-APPROVED company (owns Once+Belgrano) and one
// PENDING company with an application under review (feeds the PARKIT Ops queue).
const COMPANIES = {
  active: 'cccccccc-cccc-cccc-cccc-ccccccccccc1',
  pending: 'cccccccc-cccc-cccc-cccc-ccccccccccc2',
} as const;
const PENDING_APPLICATION = 'dddddddd-dddd-dddd-dddd-ddddddddddd1';
const PENDING_DOCUMENT = 'dddddddd-dddd-dddd-dddd-ddddddddddc1';
const ZONES = {
  once: 'ffffffff-ffff-ffff-ffff-fffffffffff1',
  belgrano: 'ffffffff-ffff-ffff-ffff-fffffffffff2',
} as const;

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
 * (needs the users owner@once.test and owner-pending@once.test).
 * Runs as part of `make seed-all` (seed-global -> seed-auth -> seed-tenant).
 */
async function seedOnboarding(): Promise<void> {
  const onboardingTables = [
    'companies',
    'onboarding_applications',
    'company_documents',
    'payment_methods',
    'zones',
  ];
  for (const table of onboardingTables) {
    if (!(await tableExists(table))) {
      console.warn(`⚠ Skipping onboarding seed: missing table "${table}".`);
      return;
    }
  }

  const owner = await prisma.user.findFirst({
    where: { email: 'owner@once.test' },
  });
  const ownerPending = await prisma.user.findFirst({
    where: { email: 'owner-pending@once.test' },
  });
  if (!owner || !ownerPending) {
    console.warn('⚠ Skipping onboarding seed: run `make seed-auth` first.');
    return;
  }

  // --- APPROVED company: owns Once + Belgrano ---
  await prisma.company.upsert({
    where: { id: COMPANIES.active },
    create: {
      id: COMPANIES.active,
      legalName: 'Estacionamientos Centro SA',
      cuit: '30700000001',
      email: 'centro@parkit.test',
      phone: '+541140000000',
      address: 'Av. Corrientes 1000, CABA',
      status: 'active',
      ownerUserId: owner.id,
    },
    update: { status: 'active', ownerUserId: owner.id },
  });

  await prisma.tenant.update({
    where: { id: TENANTS.once },
    data: { companyId: COMPANIES.active, address: 'Bartolomé Mitre 2500, CABA' },
  });
  await prisma.tenant.update({
    where: { id: TENANTS.belgrano },
    data: { companyId: COMPANIES.active, address: 'Av. Cabildo 2000, CABA' },
  });

  for (const [type, name, isDefault] of [
    ['mp_transfer', 'Bank transfer (Mercado Pago)', true],
    ['cash', 'Cash', false],
  ] as const) {
    await prisma.paymentMethod.upsert({
      where: { companyId_type: { companyId: COMPANIES.active, type } },
      create: {
        companyId: COMPANIES.active,
        type,
        name,
        enabled: true,
        isSystem: true,
        isDefault,
      },
      update: { name, isSystem: true },
    });
  }

  await prisma.zone.upsert({
    where: { id: ZONES.once },
    create: {
      id: ZONES.once,
      tenantId: TENANTS.once,
      name: 'Ground floor',
      carSpots: 40,
      motorcycleSpots: 10,
      bicycleSpots: 5,
    },
    update: { carSpots: 40, motorcycleSpots: 10, bicycleSpots: 5 },
  });
  await prisma.zone.upsert({
    where: { id: ZONES.belgrano },
    create: {
      id: ZONES.belgrano,
      tenantId: TENANTS.belgrano,
      name: 'Basement',
      carSpots: 25,
      motorcycleSpots: 8,
      bicycleSpots: 0,
    },
    update: { carSpots: 25, motorcycleSpots: 8, bicycleSpots: 0 },
  });

  // --- PENDING company: application under review (PARKIT Ops queue) ---
  await prisma.company.upsert({
    where: { id: COMPANIES.pending },
    create: {
      id: COMPANIES.pending,
      legalName: 'Cocheras del Sur SRL',
      cuit: '30700000002',
      email: 'sur@parkit.test',
      phone: '+541150000000',
      address: 'Av. Rivadavia 5000, CABA',
      status: 'pending',
      ownerUserId: ownerPending.id,
    },
    update: { status: 'pending', ownerUserId: ownerPending.id },
  });

  await prisma.onboardingApplication.upsert({
    where: { id: PENDING_APPLICATION },
    create: {
      id: PENDING_APPLICATION,
      companyId: COMPANIES.pending,
      status: 'pending_review',
      submittedAt: new Date('2026-05-20T12:00:00.000Z'),
      declaredBranches: [
        {
          name: 'Caballito branch',
          address: 'Av. Rivadavia 5000, CABA',
          carSpots: 30,
          motorcycleSpots: 10,
          bicycleSpots: 5,
        },
        {
          name: 'Flores branch',
          address: 'Av. Rivadavia 7000, CABA',
          carSpots: 20,
          motorcycleSpots: 5,
          bicycleSpots: 0,
        },
      ],
    },
    update: { status: 'pending_review' },
  });

  await prisma.companyDocument.upsert({
    where: { id: PENDING_DOCUMENT },
    create: {
      id: PENDING_DOCUMENT,
      companyId: COMPANIES.pending,
      applicationId: PENDING_APPLICATION,
      name: 'Articles of incorporation.pdf',
      storagePath: 'demo/cocheras-del-sur/estatuto.pdf',
      mimeType: 'application/pdf',
    },
    update: {},
  });

  console.log(
    '✓ Seeded onboarding: 1 active company (Once+Belgrano) and 1 pending application.',
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
