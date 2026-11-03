import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { TableTemplatesService } from './table-templates.service';
import { TenantContextService } from '../database/tenant-context.service';
import type { PrismaService } from '../database/prisma.service';
import { validTableConfig } from './table-templates.dto';
import {
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
} from '@nestjs/common/constants';
import {
  TableTemplatesController,
  AdminTableTemplatesController,
} from './table-templates.controller';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';

const config = {
  version: 1,
  columns: { visibility: {}, order: ['plate'], pinnedLeft: [] },
  filters: [],
  sorting: [],
  globalSearch: '',
  pagination: { pageSize: 10 },
};
describe('table template contract', () => {
  it('accepts legacy config and new search modes and exit filters', () => {
    expect(validTableConfig(config)).toBe(true);
    expect(
      validTableConfig({
        ...config,
        globalSearchMode: 'ticket',
        filters: [{ id: 'leftAt', value: { presence: 'missing' } }],
      }),
    ).toBe(true);
  });
  it('rejects malformed versions, columns, filters, sorts and page sizes', () => {
    for (const patch of [
      { version: 2 },
      { columns: {} },
      { filters: ['x'] },
      { sorting: [{}] },
      { pagination: { pageSize: 501 } },
      { globalSearch: 1 },
    ]) {
      expect(validTableConfig({ ...config, ...patch })).toBe(false);
    }
    expect(validTableConfig(null)).toBe(false);
  });
  it('protects tenant and global administration routes with their existing guards', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, TableTemplatesController),
    ).toEqual([JwtAuthGuard, TenantMembershipGuard]);
    expect(
      Reflect.getMetadata(INTERCEPTORS_METADATA, TableTemplatesController),
    ).toEqual([TenantInterceptor]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AdminTableTemplatesController),
    ).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata('roles', AdminTableTemplatesController)).toEqual(
      ['admin'],
    );
  });
});

const databaseUrl = process.env.TABLE_TEMPLATES_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !url.pathname.startsWith('/parkit_templates_test')
  ) {
    throw new Error(
      'Table template integration tests require an isolated local parkit_templates_test database',
    );
  }
}
const dbDescribe = databaseUrl ? describe : describe.skip;
dbDescribe('table templates isolated PostgreSQL integration', () => {
  const userA = '00000000-0000-0000-0000-000000000001';
  const userB = '00000000-0000-0000-0000-000000000002';
  const tenant = '10000000-0000-0000-0000-000000000001';
  const otherTenant = '10000000-0000-0000-0000-000000000002';
  const pool = new Pool({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const context = new TenantContextService();
  const service = new TableTemplatesService(
    prisma as unknown as PrismaService,
    context,
  );
  const query = { platform: 'desktop' as const, tableKey: 'history' };
  const save = (name: string) => ({
    mutationId: crypto.randomUUID(),
    name,
    config,
  });
  const run = <T>(fn: () => T) => context.runWithTenant(tenant, fn);

  beforeAll(async () => {
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      END $$;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        'SELECT nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
      CREATE TABLE public.users(id uuid PRIMARY KEY, role text NOT NULL);
      CREATE TABLE public.tenants(id uuid PRIMARY KEY, deleted_at timestamptz);
      CREATE TABLE public.user_memberships(user_id uuid, tenant_id uuid, PRIMARY KEY(user_id,tenant_id));
      GRANT USAGE ON SCHEMA public, auth TO authenticated;
      GRANT SELECT ON public.users, public.tenants, public.user_memberships TO authenticated;
    `);
    await pool.query(
      readFileSync(
        'supabase/migrations/20261103120000_user_table_templates.sql',
        'utf8',
      ),
    );
    await pool.query(
      `INSERT INTO users VALUES ($1,'user'), ($2,'admin'); INSERT INTO tenants VALUES ($3,null), ($4,null)`
        .replace(/\$1/g, `'${userA}'`)
        .replace(/\$2/g, `'${userB}'`)
        .replace(/\$3/g, `'${tenant}'`)
        .replace(/\$4/g, `'${otherTenant}'`),
    );
  });
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE user_table_templates, user_table_template_mutations, user_memberships',
    );
    await pool.query('INSERT INTO user_memberships VALUES ($1,$2)', [
      userA,
      tenant,
    ]);
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  it('isolates user, platform, context and table, including global admin', async () => {
    const body = save('A');
    await run(() =>
      service.mutate(userA, query, 'same', body.mutationId, body),
    );
    const b = save('B');
    await run(() => service.mutate(userB, query, 'same', b.mutationId, b));
    expect(
      (await run(() => service.list(userA, query))).map((x) => x.name),
    ).toEqual(['A']);
    expect(
      await run(() => service.list(userA, { ...query, platform: 'web' })),
    ).toEqual([]);
    expect(
      await run(() => service.list(userA, { ...query, tableKey: 'clients' })),
    ).toEqual([]);
    expect(
      await context.runWithTenant(otherTenant, () =>
        service.list(userA, query),
      ),
    ).toEqual([]);
    expect(await service.list(userB, query, true)).toEqual([]);
    const adminBody = save('global');
    await service.mutate(
      userB,
      query,
      'same',
      adminBody.mutationId,
      adminBody,
      false,
      true,
    );
    expect((await service.list(userB, query, true))[0].name).toBe('global');
  });
  it('last accepted mutation wins, but retrying an old receipt never replays it', async () => {
    const old = save('old'),
      newer = save('new');
    await run(() => service.mutate(userA, query, 'id', old.mutationId, old));
    await run(() =>
      service.mutate(userA, query, 'id', newer.mutationId, newer),
    );
    const retried = await run(() =>
      service.mutate(userA, query, 'id', old.mutationId, old),
    );
    expect(retried.name).toBe('new');
    expect(
      (await pool.query('SELECT * FROM user_table_template_mutations'))
        .rowCount,
    ).toBe(2);
    const rejected = await run(() =>
      service.mutate(userA, query, 'another', old.mutationId, old),
    ).then(
      () => false,
      () => true,
    );
    expect(rejected).toBe(true);
  });
  it('serializes concurrent writes and duplicate retries atomically', async () => {
    const body = save('one');
    await Promise.all(
      Array.from({ length: 5 }, () =>
        run(() => service.mutate(userA, query, 'id', body.mutationId, body)),
      ),
    );
    expect((await run(() => service.list(userA, query))).length).toBe(1);
    expect(
      (await pool.query('SELECT * FROM user_table_template_mutations'))
        .rowCount,
    ).toBe(1);
  });
  it('imports only absent ids and never resurrects tombstones, including unknown deletes', async () => {
    const body = save('original');
    await run(() =>
      service.mutate(userA, query, 'legacy', body.mutationId, body, true),
    );
    const updated = save('updated');
    await run(() =>
      service.mutate(userA, query, 'legacy', updated.mutationId, updated),
    );
    const imported = save('stale');
    expect(
      (
        await run(() =>
          service.mutate(
            userA,
            query,
            'legacy',
            imported.mutationId,
            imported,
            true,
          ),
        )
      ).name,
    ).toBe('updated');
    await run(() =>
      service.mutate(userA, query, 'legacy', crypto.randomUUID()),
    );
    const retry = save('stale again');
    expect(
      (
        await run(() =>
          service.mutate(userA, query, 'legacy', retry.mutationId, retry, true),
        )
      ).deletedAt,
    ).not.toBeNull();
    await run(() =>
      service.mutate(userA, query, 'unknown', crypto.randomUUID()),
    );
    const unknown = save('unknown old cache');
    expect(
      (
        await run(() =>
          service.mutate(
            userA,
            query,
            'unknown',
            unknown.mutationId,
            unknown,
            true,
          ),
        )
      ).deletedAt,
    ).not.toBeNull();
  });
  it('RLS hides other users and revoked memberships and disallows direct writes', async () => {
    for (const userId of [userA, userB]) {
      const body = save(userId);
      await run(() =>
        service.mutate(userId, query, 'id', body.mutationId, body),
      );
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(
        "SELECT set_config('request.jwt.claim.sub', $1, true)",
        [userA],
      );
      expect(
        (
          await client.query<{ user_id: string }>(
            'SELECT * FROM user_table_templates',
          )
        ).rows.map((x) => x.user_id),
      ).toEqual([userA]);
      const denied = await client
        .query('DELETE FROM user_table_templates')
        .then(
          () => false,
          () => true,
        );
      expect(denied).toBe(true);
      await client.query('ROLLBACK');
      await pool.query('DELETE FROM user_memberships WHERE user_id = $1', [
        userA,
      ]);
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(
        "SELECT set_config('request.jwt.claim.sub', $1, true)",
        [userA],
      );
      expect(
        (await client.query('SELECT * FROM user_table_templates')).rows,
      ).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
