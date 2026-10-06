import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { LprIgnoredPlate, PrismaClient } from '@prisma/client';
import { MembershipRole } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { prismaForTenant } from '../database/prisma-tenant';
import { ENTITY_ROLE_KEY } from '../auth/decorators/entity-role.decorator';
import {
  CreateLprIgnoredPlateDto,
  UpdateLprIgnoredPlateDto,
} from './dto/lpr-ignored-plate.dto';
import { LprIgnoredPlatesService } from './lpr-ignored-plates.service';
import { LprIgnoredPlatesController } from './lpr-ignored-plates.controller';

const tenantId = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const row = (overrides: Partial<LprIgnoredPlate> = {}): LprIgnoredPlate => ({
  id,
  tenantId,
  plate: 'IAG574',
  active: true,
  notes: null,
  validFrom: null,
  validUntil: null,
  version: 1,
  syncSeq: 1,
  deletedAt: null,
  createdAt: new Date('2026-10-06'),
  updatedAt: new Date('2026-10-06'),
  ...overrides,
});
const db = {
  lprIgnoredPlate: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findFirstOrThrow: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
  },
};
const service = new LprIgnoredPlatesService(
  { getTenantClient: () => db } as unknown as PrismaService,
  { getTenantIdOrThrow: () => tenantId } as TenantContextService,
);

async function expectStatus(promise: Promise<unknown>, status: number) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toMatchObject({ status });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.lprIgnoredPlate.findFirst.mockResolvedValue(null);
  db.lprIgnoredPlate.create.mockResolvedValue(row());
  db.lprIgnoredPlate.findFirstOrThrow.mockResolvedValue(row());
  db.lprIgnoredPlate.updateMany.mockResolvedValue({ count: 1 });
});

describe('Lista blanca backend', () => {
  it('normaliza la patente y asigna el tenant del contexto', async () => {
    await service.create({
      id,
      plate: ' iag-_574 ',
      validFrom: '2026-10-06',
      validUntil: '2026-10-06',
    });
    expect(db.lprIgnoredPlate.create.mock.calls[0][0]).toMatchObject({
      data: {
        id,
        tenantId,
        plate: 'IAG574',
        validFrom: new Date('2026-10-06'),
      },
    });
  });
  it('reintentar un alta no duplica registros', async () => {
    db.lprIgnoredPlate.findFirst.mockResolvedValue(row());
    expect((await service.create({ id, plate: 'IAG574' })).id).toBe(id);
    expect(db.lprIgnoredPlate.create).not.toHaveBeenCalled();
  });
  it('rechaza vigencia invertida, también en ediciones parciales', async () => {
    await expectStatus(
      service.create({
        id,
        plate: 'IAG574',
        validFrom: '2026-10-07',
        validUntil: '2026-10-06',
      }),
      400,
    );
    db.lprIgnoredPlate.findFirst.mockResolvedValue(
      row({ validUntil: new Date('2026-10-06') }),
    );
    await expectStatus(service.update(id, 1, { validFrom: '2026-10-07' }), 400);
    expect(db.lprIgnoredPlate.updateMany).not.toHaveBeenCalled();
  });
  it('controla versión y alcance del tenant al modificar', async () => {
    db.lprIgnoredPlate.findFirst.mockResolvedValue(row());
    db.lprIgnoredPlate.updateMany.mockResolvedValue({ count: 0 });
    await expectStatus(service.update(id, 1, { active: false }), 409);
    expect(db.lprIgnoredPlate.updateMany).toHaveBeenCalledWith({
      where: { id, tenantId, version: 1, deletedAt: null },
      data: { version: { increment: 1 }, active: false },
    });
  });
  it('envía las bajas en el feed incremental', async () => {
    db.lprIgnoredPlate.findMany.mockResolvedValue([
      row({ deletedAt: new Date('2026-10-07'), syncSeq: 8 }),
    ]);
    const result = await service.changes({ afterSeq: 4, limit: 1000 });
    expect(result.maxSeq).toBe(8);
    expect(result.items[0].deletedAt).toBe('2026-10-07T00:00:00.000Z');
    expect(db.lprIgnoredPlate.findMany).toHaveBeenCalledWith({
      where: { syncSeq: { gt: 4 } },
      orderBy: { syncSeq: 'asc' },
      take: 1000,
    });
  });
  it('borra lógicamente y permite repetir una baja confirmada', async () => {
    db.lprIgnoredPlate.findFirst.mockResolvedValue(row());
    await service.remove(id, 1);
    const deletion = db.lprIgnoredPlate.updateMany.mock.calls[0][0] as {
      data: { deletedAt: Date };
    };
    expect(deletion).toMatchObject({
      where: { id, tenantId, version: 1, deletedAt: null },
      data: { version: { increment: 1 } },
    });
    expect(deletion.data.deletedAt).toBeInstanceOf(Date);
    db.lprIgnoredPlate.findFirst.mockResolvedValue(
      row({ deletedAt: new Date('2026-10-07') }),
    );
    db.lprIgnoredPlate.updateMany.mockClear();
    await service.remove(id, 1);
    expect(db.lprIgnoredPlate.updateMany).not.toHaveBeenCalled();
  });
  it('acepta actualizaciones parciales y limpiar fechas; rechaza null para activo o patente', async () => {
    expect(
      await validate(
        plainToInstance(UpdateLprIgnoredPlateDto, { validUntil: null }),
      ),
    ).toHaveLength(0);
    expect(
      await validate(plainToInstance(UpdateLprIgnoredPlateDto, {})),
    ).toHaveLength(0);
    expect(
      await validate(
        plainToInstance(UpdateLprIgnoredPlateDto, { active: null }),
      ),
    ).not.toHaveLength(0);
    expect(
      await validate(
        plainToInstance(UpdateLprIgnoredPlateDto, { plate: null }),
      ),
    ).not.toHaveLength(0);
    expect(
      await validate(
        plainToInstance(CreateLprIgnoredPlateDto, {
          id,
          plate: 'IAG574',
          validFrom: '2026-02-30',
        }),
      ),
    ).not.toHaveLength(0);
  });
  it('reserva las mutaciones al dueño y deja lecturas a los miembros', () => {
    for (const name of ['create', 'update', 'remove'] as const)
      expect(
        Reflect.getMetadata(
          ENTITY_ROLE_KEY,
          LprIgnoredPlatesController.prototype[name],
        ),
      ).toBe(MembershipRole.owner);
    expect(
      Reflect.getMetadata(
        ENTITY_ROLE_KEY,
        Object.getOwnPropertyDescriptor(
          LprIgnoredPlatesController.prototype,
          'list',
        )!.value as object,
      ),
    ).toBeUndefined();
  });
  it('la extensión tenant incluye la nueva entidad y reemplaza un tenant ajeno en lecturas', async () => {
    const client = {
      $extends: (config: unknown) => config,
    } as unknown as PrismaClient;
    const config = prismaForTenant(client, tenantId) as unknown as {
      query: {
        $allModels: { $allOperations: (input: unknown) => Promise<unknown> };
      };
    };
    const query = jest.fn().mockResolvedValue([]);
    await config.query.$allModels.$allOperations({
      model: 'LprIgnoredPlate',
      operation: 'findMany',
      args: { where: { tenantId: 'other' } },
      query,
    });
    expect(query).toHaveBeenCalledWith({ where: { tenantId } });
    const error = await config.query.$allModels
      .$allOperations({
        model: 'LprIgnoredPlate',
        operation: 'updateMany',
        args: { where: { id } },
        query,
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('without tenantId');
  });
});
