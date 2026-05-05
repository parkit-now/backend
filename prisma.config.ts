import { defineConfig } from 'prisma/config';

// Prisma 7: connection URLs no longer live in the schema. Define them here.
//   - migrate.adapter → consumed by `prisma db push` / `prisma migrate`.
//     Uses DIRECT_URL (no pgbouncer) so DDL commands work end-to-end.
//   - The runtime client lives in src/database/prisma.service.ts and reads
//     DATABASE_URL (the pooled URL) directly.
export default defineConfig({
    schema: './prisma/schema',
    migrate: {
        async adapter() {
            const { Pool } = await import('pg');
            const { PrismaPg } = await import('@prisma/adapter-pg');
            const pool = new Pool({
                connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
            });
            return new PrismaPg(pool);
        },
    },
});
