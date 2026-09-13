// Local-only Supabase Auth seed.
//
// Creates a small set of demo users in Supabase Auth and links them to the
// tenants seeded by `supabase/seed.sql` via the `user_memberships` table.
// Idempotent — safe to run multiple times.
//
// Roles-v2 model:
//   - GLOBAL role (`User.role`): `admin | user`. `admin` is god mode and has
//     no memberships (it bypasses them). Everyone else is `user`.
//   - ENTITY role lives on `user_memberships.role` (`owner | operator`), per
//     lot. A single `user` can be owner of one lot and operator of another.
//
// The active entity is NOT carried in the JWT (only the global role); it is
// resolved per request from `/tenants/:tenantId` + TenantMembershipGuard and
// chosen client-side from `GET /auth/me`.
//
// Guardrails:
//   - Refuses to run unless SUPABASE_URL points to localhost / 127.0.0.1.
//   - Refuses to run without SUPABASE_SERVICE_ROLE_KEY and DATABASE_URL.
//
// Trigger: `make seed-auth` or `bun run seed:auth`.

import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  type MembershipRole,
  type UserRole,
} from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import { Pool } from 'pg';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const DATABASE_URL = process.env.DATABASE_URL ?? '';

if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(SUPABASE_URL)) {
  console.error('✗ Refusing to seed: SUPABASE_URL is not local.');
  console.error(`  SUPABASE_URL=${SUPABASE_URL || '(unset)'}`);
  process.exit(1);
}
if (!SERVICE_ROLE_KEY || !DATABASE_URL) {
  console.error('✗ Missing SUPABASE_SERVICE_ROLE_KEY or DATABASE_URL in env.');
  process.exit(1);
}

const TENANTS = {
  once: '11111111-1111-4111-8111-111111111111',
  belgrano: '22222222-2222-4222-8222-222222222222',
  palermo: '33333333-3333-4333-8333-333333333333',
} as const;

type SeedMembership = { tenantId: string; role: MembershipRole };

type SeedUser = {
  email: string;
  password: string;
  role: UserRole;
  /**
   * Entities (parking lots) the user is linked to, each with its per-entity
   * role. Omitted for admin (god mode, bypasses membership) and plain users
   * with no lots.
   */
  memberships?: SeedMembership[];
};

// Demo credentials are intentionally trivial and uniform for local dev: every
// account uses the password below and a `<role>@example.com` email. NEVER reuse
// this anywhere but a local stack (the guardrails above enforce localhost).
const DEMO_PASSWORD = '12345678';

const USERS: SeedUser[] = [
  { email: 'admin@example.com', password: DEMO_PASSWORD, role: 'admin' },
  {
    email: 'owner@example.com',
    password: DEMO_PASSWORD,
    role: 'user',
    memberships: [
      { tenantId: TENANTS.once, role: 'owner' },
      { tenantId: TENANTS.belgrano, role: 'owner' },
    ],
  },
  {
    email: 'operator@example.com',
    password: DEMO_PASSWORD,
    role: 'user',
    memberships: [
      { tenantId: TENANTS.once, role: 'operator' },
      { tenantId: TENANTS.belgrano, role: 'operator' },
    ],
  },
  {
    email: 'solo-once@example.com',
    password: DEMO_PASSWORD,
    role: 'user',
    memberships: [{ tenantId: TENANTS.once, role: 'operator' }],
  },
  // Dueño de OTRA sociedad (Cocheras Palermo SRL), con una sola playa. Existe
  // para que el aislamiento entre entidades se pueda probar de verdad: si
  // entra acá y ve Once o Belgrano, hay un bug de membresías.
  {
    email: 'owner-palermo@example.com',
    password: DEMO_PASSWORD,
    role: 'user',
    memberships: [{ tenantId: TENANTS.palermo, role: 'owner' }],
  },
  { email: 'driver@example.com', password: DEMO_PASSWORD, role: 'user' },
  // Applicant of the "pending" onboarding application (no lots yet; its entity
  // is materialized as a tenant + owner membership when the application is
  // approved). Stays a plain `user`; the owner role comes from the membership.
  { email: 'owner-pending@example.com', password: DEMO_PASSWORD, role: 'user' },
];

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const pool = new Pool({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main(): Promise<void> {
  const { data: existing, error: listErr } =
    await supabaseAdmin.auth.admin.listUsers({
      perPage: 200,
    });
  if (listErr) throw listErr;
  const existingByEmail = new Map(existing.users.map((u) => [u.email!, u]));

  for (const u of USERS) {
    const memberships = u.memberships ?? [];
    // Mirror the GLOBAL role into `app_metadata` so it is baked into the JWT
    // (clients route by `app_metadata.role`). The entity-level role is NOT
    // in the JWT — it lives on `user_memberships.role`.
    const appMetadata = { role: u.role };
    let authUser = existingByEmail.get(u.email);

    if (!authUser) {
      const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email: u.email,
        password: u.password,
        email_confirm: true,
        app_metadata: appMetadata,
      });
      if (error) throw error;
      authUser = data.user!;
      console.log(`+ created   ${u.email.padEnd(28)} role=${u.role}`);
    } else {
      await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
        password: u.password,
        app_metadata: appMetadata,
      });
      console.log(`= refreshed ${u.email.padEnd(28)} role=${u.role}`);
    }

    await prisma.user.upsert({
      where: { id: authUser.id },
      create: { id: authUser.id, role: u.role, email: u.email },
      update: { role: u.role, email: u.email },
    });

    for (const m of memberships) {
      await prisma.userMembership.upsert({
        where: {
          userId_tenantId: { userId: authUser.id, tenantId: m.tenantId },
        },
        create: { userId: authUser.id, tenantId: m.tenantId, role: m.role },
        update: { role: m.role },
      });
    }
    // Drop memberships that are no longer in the seed list (handles drift
    // from a previous run, and covers admin/plain users which have zero
    // memberships).
    const seededTenantIds = memberships.map((m) => m.tenantId);
    await prisma.userMembership.deleteMany({
      where: {
        userId: authUser.id,
        ...(seededTenantIds.length > 0
          ? { tenantId: { notIn: seededTenantIds } }
          : {}),
      },
    });
  }

  console.log(
    `\n✓ Seeded ${USERS.length} users across ${Object.keys(TENANTS).length} tenants.`,
  );
  console.log(
    `  All accounts share the password "${DEMO_PASSWORD}" (local dev only).`,
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
