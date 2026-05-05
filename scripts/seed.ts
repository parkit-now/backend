// Local-only Supabase Auth seed.
//
// Creates a small set of demo users in Supabase Auth (one per role) and,
// where applicable, links them to the tenants seeded by `supabase/seed.sql`
// via the `user_memberships` table. Idempotent — safe to run multiple times.
//
// A tenant is a parking lot. Membership rules mirror production:
//   - admin / driver  → no membership, no `app_metadata.tenant_id`.
//   - owner / operator → 1..N memberships (one per lot). The first entry of
//                        `tenantIds` is the active one and goes into
//                        `app_metadata.tenant_id`; the user can switch later.
//
// Guardrails:
//   - Refuses to run unless SUPABASE_URL points to localhost / 127.0.0.1.
//   - Refuses to run without SUPABASE_SERVICE_ROLE_KEY and DATABASE_URL.
//
// Trigger: `make seed` or `bun run seed`.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type UserRole } from '@prisma/client';
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
    once: '11111111-1111-1111-1111-111111111111',
    belgrano: '22222222-2222-2222-2222-222222222222',
} as const;

type SeedUser = {
    email: string;
    password: string;
    role: UserRole;
    /**
     * Tenants (parking lots) the user is linked to. First entry is the
     * active one (goes into `app_metadata.tenant_id`). Omitted for admin
     * and driver.
     */
    tenantIds?: string[];
};

const USERS: SeedUser[] = [
    { email: 'admin@once.test',    password: 'AdminPass123!',    role: 'admin'                                                            },
    { email: 'owner@once.test',    password: 'OwnerPass123!',    role: 'owner',    tenantIds: [TENANTS.once, TENANTS.belgrano]            },
    { email: 'operator@once.test', password: 'OperatorPass123!', role: 'operator', tenantIds: [TENANTS.once, TENANTS.belgrano]            },
    { email: 'driver@once.test',   password: 'DriverPass123!',   role: 'driver'                                                           },
];

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
});

const pool = new Pool({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main(): Promise<void> {
    const { data: existing, error: listErr } = await supabaseAdmin.auth.admin.listUsers({
        perPage: 200,
    });
    if (listErr) throw listErr;
    const existingByEmail = new Map(existing.users.map((u) => [u.email!, u]));

    for (const u of USERS) {
        const tenantIds = u.tenantIds ?? [];
        const appMetadata = tenantIds.length > 0 ? { tenant_id: tenantIds[0] } : {};
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

        for (const tenantId of tenantIds) {
            await prisma.userMembership.upsert({
                where: { userId_tenantId: { userId: authUser.id, tenantId } },
                create: { userId: authUser.id, tenantId },
                update: {},
            });
        }
        // Drop memberships that are no longer in the seed list (handles
        // drift from a previous run with a different set of tenants, and
        // covers admin/driver which always have zero memberships).
        await prisma.userMembership.deleteMany({
            where: {
                userId: authUser.id,
                ...(tenantIds.length > 0 ? { tenantId: { notIn: tenantIds } } : {}),
            },
        });
    }

    console.log(`\n✓ Seeded ${USERS.length} users across ${Object.keys(TENANTS).length} tenants.`);
    console.log('  All passwords match the table above; treat as throwaway.');
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
