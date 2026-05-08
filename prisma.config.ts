import { defineConfig } from 'prisma/config';

// Prisma 7: datasource URLs are configured here (not in the schema file).
// We keep SQL migrations in `supabase/migrations`; Prisma is used for client
// generation and schema typing.
export default defineConfig({
  schema: './prisma/schema',
  datasource: {
    // For CLI/database commands that need a connection, prefer DIRECT_URL
    // and fallback to DATABASE_URL.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  },
});
