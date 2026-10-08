import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PrismaService } from '../database/prisma.service';
import type { TenantContextService } from '../database/tenant-context.service';
import { normalizeClientPlate, CreateClientDto } from './dto/client.dto';
import { ClientsService } from './clients.service';

const tenantId = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const now = new Date('2026-10-07T00:00:00Z');
const row = {
  id,
  tenantId,
  cuit: '20427205208',
  name: 'Ian',
  nameEdited: false,
  email: null,
  phone: null,
  version: 2,
  syncSeq: 3,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
  plates: [
    {
      id: 'plate',
      tenantId,
      clientId: id,
      plate: 'IAG574',
      deletedAt: null,
      createdAt: now,
    },
  ],
};
const tx = {
  client: {
    findFirst: jest.fn(),
    findFirstOrThrow: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
  },
  clientPlate: {
    findMany: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
  },
};
const prisma = {
  getTenantClient: () => ({
    $transaction: transaction,
    client: { findMany: jest.fn() },
  }),
};
function transaction(callback: (value: typeof tx) => Promise<unknown>) {
  return callback(tx);
}
const service = new ClientsService(
  prisma as unknown as PrismaService,
  { getTenantIdOrThrow: () => tenantId } as TenantContextService,
);

beforeEach(() => {
  jest.clearAllMocks();
  tx.client.findFirst.mockResolvedValue(null);
  tx.client.findFirstOrThrow.mockResolvedValue(row);
  tx.client.updateMany.mockResolvedValue({ count: 1 });
  tx.clientPlate.findMany.mockResolvedValue([]);
  tx.clientPlate.count.mockResolvedValue(0);
});

async function expectStatus(promise: Promise<unknown>, status: number) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toMatchObject({ status });
}

describe('Clientes por patente', () => {
  it('normaliza patentes y valida duplicados luego de normalizar', async () => {
    expect(normalizeClientPlate(' iag-_574 ')).toBe('IAG574');
    const dto = plainToInstance(CreateClientDto, {
      id,
      plates: ['iag-574', 'IAG574'],
    });
    expect(await validate(dto)).not.toEqual([]);
    await expectStatus(
      service.create({ id, plates: ['iag-574', 'IAG574'] }),
      400,
    );
  });

  it('rechaza CUIT inválido y no toca la base', async () => {
    await expectStatus(
      service.create({ id, plates: ['IAG574'], cuit: '20427205209' }),
      400,
    );
    expect(tx.client.create).not.toHaveBeenCalled();
  });

  it('crea el cliente y la patente dentro del tenant', async () => {
    await service.create({ id, plates: ['iag-574'], cuit: '20-42720520-8' });
    expect(tx.client.create.mock.calls[0]?.[0]).toMatchObject({
      data: { id, tenantId, cuit: '20427205208' },
    });
    expect(tx.clientPlate.create).toHaveBeenCalledWith({
      data: { tenantId, clientId: id, plate: 'IAG574' },
    });
  });

  it('distingue el nombre de ARCA de uno ingresado por el dueño', async () => {
    await service.create({
      id,
      plates: ['IAG574'],
      name: 'Nombre de ARCA',
      nameIsAutomatic: true,
    });
    const createCall: unknown = tx.client.create.mock.calls[0]?.[0];
    expect(createCall).toMatchObject({ data: { nameEdited: false } });

    tx.client.findFirst.mockResolvedValue({
      ...row,
      name: 'Nombre del dueño',
      nameEdited: true,
    });
    await service.update(id, 2, {
      name: 'Otro nombre de ARCA',
      nameIsAutomatic: true,
    });
    const updateCall: unknown = tx.client.updateMany.mock.calls[0]?.[0];
    expect(updateCall).toMatchObject({ data: { nameEdited: true } });
  });

  it('exige confirmación al mover una patente y controla la versión', async () => {
    tx.client.findFirst.mockResolvedValue(row);
    tx.clientPlate.findMany.mockResolvedValueOnce([
      {
        id: 'other-plate',
        tenantId,
        clientId: 'other',
        plate: 'IAG574',
        deletedAt: null,
      },
    ]);
    await expectStatus(service.update(id, 2, { plates: ['IAG574'] }), 409);
    tx.client.updateMany.mockResolvedValue({ count: 0 });
    await expectStatus(
      service.update(id, 1, { email: 'ian@example.com' }),
      409,
    );
    expect(tx.client.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id, tenantId, version: 1, deletedAt: null },
      }),
    );
  });
});
