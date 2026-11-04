import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import {
  PrismaClient,
  MembershipRole,
  type UserMembership,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
} from '@nestjs/common/constants';
import { PlateProfilesController } from './plate-profiles.controller';
import { PlateProfilesService } from './plate-profiles.service';
import {
  CreatePlateProfileDto,
  UpdatePlateProfileDto,
} from './dto/plate-profile.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { TenantContextService } from '../database/tenant-context.service';
import { prismaForTenant } from '../database/prisma-tenant';
import type { PrismaService } from '../database/prisma.service';

async function expectFailure(promise: Promise<unknown>, status?: number) {
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeTruthy();
  if (status) expect(error).toMatchObject({ status });
}

describe('plate profiles contract and permissions', () => {
  it('normalizes plates and validates version, mutation and references', async () => {
    const valid = plainToInstance(CreatePlateProfileDto, {
      occurredAt: new Date().toISOString(),
      plate: ' ab-123 cd ',
      expectedVersion: 0,
      mutationId: crypto.randomUUID(),
      color: 'NEGRO',
    });
    expect(valid.plate).toBe('AB123CD');
    expect(await validate(valid)).toEqual([]);
    for (const patch of [
      { expectedVersion: -1 },
      { mutationId: 'bad' },
      { rateId: 'bad' },
      { vehicleBrand: 'a'.repeat(121) },
      { plate: '' },
    ])
      expect(
        (
          await validate(
            plainToInstance(CreatePlateProfileDto, { ...valid, ...patch }),
          )
        ).length,
      ).toBeGreaterThan(0);
    expect(
      await validate(
        plainToInstance(UpdatePlateProfileDto, {
          expectedVersion: 0,
          mutationId: crypto.randomUUID(),
          plate: 'CHANGED',
        }),
        { whitelist: true, forbidNonWhitelisted: true },
      ),
    ).not.toEqual([]);
  });
  it('protects membership and owner CRUD, including an admin without owner membership', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, PlateProfilesController),
    ).toEqual([JwtAuthGuard, TenantMembershipGuard]);
    expect(
      Reflect.getMetadata(INTERCEPTORS_METADATA, PlateProfilesController),
    ).toEqual([TenantInterceptor]);
    const controller = new PlateProfilesController({} as PlateProfilesService);
    const body = {
      occurredAt: new Date().toISOString(),
      plate: 'AB123CD',
      expectedVersion: 0,
      mutationId: crypto.randomUUID(),
    };
    for (const membership of [
      null,
      { role: MembershipRole.operator } as UserMembership,
    ]) {
      expect(() => controller.create(body, membership)).toThrow();
      expect(() => controller.update(body.plate, body, membership)).toThrow();
      expect(() => controller.remove(body.plate, body, membership)).toThrow();
    }
  });
});

const databaseUrl = process.env.PLATE_PROFILES_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.pathname !== '/parkit_plate_profiles_test'
  )
    throw new Error(
      'Use only an isolated local parkit_plate_profiles_test database',
    );
}
const dbDescribe = databaseUrl ? describe : describe.skip;
dbDescribe('plate profiles isolated PostgreSQL integration', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const context = new TenantContextService();
  const tenant = '10000000-0000-4000-8000-000000000001';
  const other = '10000000-0000-4000-8000-000000000002';
  const owner = '20000000-0000-4000-8000-000000000001';
  const operator = '20000000-0000-4000-8000-000000000002';
  const outsider = '20000000-0000-4000-8000-000000000003';
  const service = new PlateProfilesService(
    {
      getTenantClient: () =>
        prismaForTenant(prisma, context.getTenantIdOrThrow()),
    } as PrismaService,
    context,
  );
  const run = <T>(fn: () => T) => context.runWithTenant(tenant, fn);
  const save = (expectedVersion = 0, color = 'NEGRO') => ({
    occurredAt: new Date().toISOString(),
    expectedVersion,
    mutationId: crypto.randomUUID(),
    color,
  });
  const add = async (
    plate: string,
    enteredAt: string,
    color = 'NEGRO',
    id = crypto.randomUUID(),
  ) => {
    await pool.query(
      'INSERT INTO entries(id,tenant_id,plate,entered_at,vehicle_brand,vehicle_model,color) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, tenant, plate, enteredAt, 'Ford', 'Ranger', color],
    );
    return id;
  };
  beforeAll(async () => {
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      END $$;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        'SELECT nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
      CREATE TABLE tenants(id uuid PRIMARY KEY);
      CREATE TABLE user_memberships(user_id uuid, tenant_id uuid, role text);
      CREATE TABLE vehicle_types(id uuid PRIMARY KEY, tenant_id uuid, name text, deleted_at timestamptz);
      CREATE TABLE rates(id uuid PRIMARY KEY, tenant_id uuid, name text, deleted_at timestamptz);
      CREATE TABLE entries(id uuid PRIMARY KEY, tenant_id uuid, plate text, entered_at timestamptz,
        vehicle_brand text, vehicle_model text, vehicle_type_id uuid, color text, rate_id uuid,
        rate_snapshot_name text, deleted_at timestamptz, notes text, left_at timestamptz);
      CREATE FUNCTION public.clients_can_manage(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS
        'SELECT EXISTS(SELECT FROM public.user_memberships WHERE tenant_id=target AND user_id=auth.uid() AND role=''owner'')';
      CREATE FUNCTION public.lpr_ignored_plates_can_access(target uuid, manage boolean) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS
        'SELECT EXISTS(SELECT FROM public.user_memberships WHERE tenant_id=target AND user_id=auth.uid())';
      GRANT USAGE ON SCHEMA public,auth TO authenticated;
    `);
    await pool.query('INSERT INTO tenants VALUES ($1),($2)', [tenant, other]);
    await pool.query(
      "INSERT INTO user_memberships VALUES ($1,$3,'owner'),($2,$3,'operator')",
      [owner, operator, tenant],
    );
    await add('BACKFILL', '2026-01-01T00:00:00Z');
    await pool.query(
      "UPDATE entries SET vehicle_brand='VW', vehicle_model='Bora' WHERE plate='BACKFILL'",
    );
    await pool.query(
      "INSERT INTO entries(id,tenant_id,plate,entered_at,color) VALUES ($1,$2,'BACKFILL','2026-02-01T00:00:00Z','ROJO')",
      [crypto.randomUUID(), tenant],
    );
    await pool.query(
      readFileSync(
        'supabase/migrations/20261103130000_plate_profiles.sql',
        'utf8',
      ),
    );
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  it('backfills full history with the latest nonempty fields and coherent brand/model', async () => {
    expect(await run(() => service.get('BACKFILL'))).toMatchObject({
      vehicleBrand: 'VW',
      vehicleModel: 'Bora',
      color: 'ROJO',
      lastEnteredAt: '2026-02-01T00:00:00.000Z',
    });
  });
  it('learns newest visits, corrections only to changed fields, and ignores exits and deletions', async () => {
    const id = await add('LEARN', '2026-03-02T00:00:00Z');
    await add('LEARN', '2026-03-01T00:00:00Z', 'AZUL');
    const initial = await run(() => service.get('LEARN'));
    expect(initial.color).toBe('NEGRO');
    await run(() => service.mutate('LEARN', save(0, 'ROJO'), 'update'));
    await pool.query(
      "UPDATE entries SET notes='note',left_at=now() WHERE id=$1",
      [id],
    );
    expect((await run(() => service.get('LEARN'))).color).toBe('ROJO');
    await pool.query("UPDATE entries SET vehicle_model='Fiesta' WHERE id=$1", [
      id,
    ]);
    expect(await run(() => service.get('LEARN'))).toMatchObject({
      color: 'ROJO',
      vehicleModel: 'Fiesta',
    });
    await pool.query('UPDATE entries SET deleted_at=now() WHERE id=$1', [id]);
    expect((await run(() => service.get('LEARN'))).vehicleModel).toBe('Fiesta');
  });
  it('retains deleted profiles and only a new confirmed entry can recreate them', async () => {
    const id = await add('FORGET', '2026-03-01T00:00:00Z');
    const deleted = await run(() => service.mutate('FORGET', save(), 'delete'));
    await pool.query("UPDATE entries SET color='ROJO' WHERE id=$1", [id]);
    await add('FORGET', '2026-03-02T00:00:00Z');
    expect((await run(() => service.get('FORGET'))).deletedAt).toBe(
      deleted.deletedAt,
    );
    await add('FORGET', new Date(Date.now() + 1000).toISOString(), 'AZUL');
    expect(await run(() => service.get('FORGET'))).toMatchObject({
      deletedAt: null,
      color: 'AZUL',
    });
  });
  it('uses a stable id tie break and checks actual visit order after time corrections', async () => {
    const first = '60000000-0000-4000-8000-000000000002';
    const second = '60000000-0000-4000-8000-000000000001';
    await add('TIED', '2026-03-02T00:00:00Z', 'ROJO', first);
    await add('TIED', '2026-03-02T00:00:00Z', 'AZUL', second);
    expect((await run(() => service.get('TIED'))).color).toBe('ROJO');
    await pool.query(
      "UPDATE entries SET entered_at='2026-03-01T00:00:00Z' WHERE id=$1",
      [first],
    );
    await pool.query("UPDATE entries SET color='GRIS' WHERE id=$1", [first]);
    expect((await run(() => service.get('TIED'))).color).toBe('ROJO');
    await pool.query("UPDATE entries SET color='BLANCO' WHERE id=$1", [second]);
    expect(await run(() => service.get('TIED'))).toMatchObject({
      lastEntryId: second,
      color: 'BLANCO',
    });
  });
  it('enforces CAS for concurrent owners while keeping learning separate and retries idempotent', async () => {
    await add('CAS', '2026-03-01T00:00:00Z');
    const request = save(0, 'ROJO');
    await run(() => service.mutate('CAS', request, 'update'));
    await expectFailure(
      run(() => service.mutate('CAS', save(0), 'update')),
      409,
    );
    await run(() => service.mutate('CAS', save(1, 'AZUL'), 'update'));
    expect(
      (await run(() => service.mutate('CAS', request, 'update'))).color,
    ).toBe('AZUL');
    await add('CAS', new Date(Date.now() + 2000).toISOString(), 'BLANCO');
    expect(await run(() => service.get('CAS'))).toMatchObject({
      color: 'BLANCO',
      editVersion: 2,
    });
    await run(() => service.mutate('CAS', save(2, 'NEGRO'), 'update'));
    const changes = await run(() =>
      service.changes({ afterSeq: 0, limit: 1000 }),
    );
    expect(changes.items.map((x) => x.syncSeq)).toEqual(
      changes.items.map((x) => x.syncSeq).sort((a, b) => a - b),
    );
    expect(changes.maxSeq).toBe(changes.items.at(-1)!.syncSeq);
  });
  it('keeps stable identity across devices and scopes natural keys by parking', async () => {
    const input = {
      ...save(),
      plate: 'MANUAL',
      vehicleBrand: 'Especial',
      vehicleModel: 'Sin catálogo',
    };
    await run(() => service.mutate(input.plate, input, 'create'));
    await context.runWithTenant(other, () =>
      service.mutate(
        input.plate,
        { ...input, mutationId: crypto.randomUUID() },
        'create',
      ),
    );
    expect(
      (await run(() => service.list())).filter((x) => x.plate === 'MANUAL'),
    ).toHaveLength(1);
    const t = prismaForTenant(prisma, tenant);
    expect(
      await t.plateProfile.findMany({ where: { tenantId: other } }),
    ).not.toEqual([]);
    expect(
      (await t.plateProfile.findMany()).every((x) => x.tenantId === tenant),
    ).toBe(true);
  });
  it('preserves original offline order rather than server arrival time', async () => {
    await add('OFFLINE', '2026-01-01T00:00:00Z');
    await run(() =>
      service.mutate(
        'OFFLINE',
        { ...save(), occurredAt: '2026-02-01T00:00:00Z' },
        'update',
      ),
    );
    await add('OFFLINE', '2026-03-01T00:00:00Z', 'ROJO');
    expect((await run(() => service.get('OFFLINE'))).color).toBe('ROJO');
    await run(() =>
      service.mutate(
        'OFFLINE',
        { ...save(1), occurredAt: '2026-04-01T00:00:00Z' },
        'delete',
      ),
    );
    await add('OFFLINE', '2026-05-01T00:00:00Z', 'AZUL');
    expect(await run(() => service.get('OFFLINE'))).toMatchObject({
      deletedAt: null,
      color: 'AZUL',
    });
  });
  it('rejects options from another tenant and retains old references on unrelated edits', async () => {
    const foreign = crypto.randomUUID();
    await pool.query("INSERT INTO rates VALUES ($1,$2,'Ajena',NULL)", [
      foreign,
      other,
    ]);
    await expectFailure(
      run(() =>
        service.mutate('FOREIGN', { ...save(), rateId: foreign }, 'create'),
      ),
      400,
    );
    const own = crypto.randomUUID();
    await pool.query("INSERT INTO rates VALUES ($1,$2,'Hora',NULL)", [
      own,
      tenant,
    ]);
    await run(() =>
      service.mutate('REFS', { ...save(), rateId: own }, 'create'),
    );
    await pool.query('UPDATE rates SET deleted_at=now() WHERE id=$1', [own]);
    expect(
      await run(() =>
        service.mutate('REFS', { ...save(1), rateId: own }, 'update'),
      ),
    ).toMatchObject({ rateId: own, rateName: 'Hora' });
  });
  it('RLS permits operational reads but only actual owners can write; receipts are private', async () => {
    const connection = await pool.connect();
    try {
      for (const user of [owner, operator, outsider]) {
        await connection.query('BEGIN');
        await connection.query(
          "SELECT set_config('request.jwt.claim.sub',$1,true)",
          [user],
        );
        await connection.query('SET LOCAL ROLE authenticated');
        const rows = await connection.query(
          'SELECT plate FROM plate_profiles WHERE tenant_id=$1',
          [tenant],
        );
        expect(rows.rowCount! > 0).toBe(user !== outsider);
        expect(
          (
            await connection.query(
              'SELECT plate FROM plate_profiles WHERE tenant_id=$1',
              [other],
            )
          ).rowCount,
        ).toBe(0);
        const updated = await connection.query(
          "UPDATE plate_profiles SET color='GRIS' WHERE tenant_id=$1",
          [tenant],
        );
        expect(updated.rowCount! > 0).toBe(user === owner);
        await expectFailure(
          connection.query('SELECT * FROM plate_profile_mutations'),
        );
        await connection.query('ROLLBACK');
      }
      await connection.query('BEGIN');
      await connection.query(
        "SELECT set_config('request.jwt.claim.sub',$1,true)",
        [operator],
      );
      await connection.query('SET LOCAL ROLE authenticated');
      await expectFailure(
        connection.query(
          "INSERT INTO plate_profiles(tenant_id,plate) VALUES ($1,'DENIED')",
          [tenant],
        ),
      );
      await connection.query('ROLLBACK');
    } finally {
      connection.release();
    }
  });
});
