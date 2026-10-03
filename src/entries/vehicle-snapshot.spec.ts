import type { Prisma } from '@prisma/client';
import { resolveVehicleSnapshot } from './vehicle-snapshot';

const TENANT = '11111111-1111-7111-8111-111111111111';
const TYPE = '88888888-8888-7888-8888-888888888888';

describe('resolveVehicleSnapshot', () => {
  const findFirst = jest.fn();
  const db = { vehicleType: { findFirst } } as unknown as Pick<
    Prisma.TransactionClient,
    'vehicleType'
  >;

  beforeEach(() => {
    findFirst.mockReset();
  });

  it('tipo propio: manda el tipo (nombre y categoría), no lo que dijo el cliente', async () => {
    findFirst.mockResolvedValue({ id: TYPE, name: 'Autos', category: 'car' });

    const result = await resolveVehicleSnapshot(db, TENANT, {
      vehicleTypeId: TYPE,
      vehicleCategory: 'motorcycle',
    });

    expect(result).toEqual({
      vehicleTypeId: TYPE,
      vehicleType: 'Autos',
      vehicleCategory: 'car',
    });
  });

  it('busca siempre acotado al tenant y SIN filtrar borrados', async () => {
    findFirst.mockResolvedValue({
      id: TYPE,
      name: 'Bici',
      category: 'bicycle',
    });

    await resolveVehicleSnapshot(db, TENANT, { vehicleTypeId: TYPE });

    const arg = findFirst.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: TYPE, tenantId: TENANT });
    expect(arg.where).not.toHaveProperty('deletedAt');
  });

  it('tipo borrado: se resuelve igual (el historial lo tiene que seguir mostrando)', async () => {
    findFirst.mockResolvedValue({
      id: TYPE,
      name: 'Utilitario viejo',
      category: 'van',
    });

    const result = await resolveVehicleSnapshot(db, TENANT, {
      vehicleTypeId: TYPE,
    });

    expect(result.vehicleCategory).toBe('van');
    expect(result.vehicleTypeId).toBe(TYPE);
  });

  it('tipo de OTRO tenant (la búsqueda no lo encuentra): no se guarda su id y se usa la categoría del cliente', async () => {
    findFirst.mockResolvedValue(null);

    const result = await resolveVehicleSnapshot(db, TENANT, {
      vehicleTypeId: TYPE,
      vehicleCategory: 'suv',
    });

    expect(result).toEqual({
      vehicleTypeId: null,
      vehicleType: null,
      vehicleCategory: 'suv',
    });
  });

  it('una categoría inválida del cliente se ignora', async () => {
    findFirst.mockResolvedValue(null);

    const result = await resolveVehicleSnapshot(db, TENANT, {
      vehicleTypeId: TYPE,
      vehicleCategory: 'monopatin',
    });

    expect(result.vehicleCategory).toBeNull();
  });

  it('sin nada: todo null y sin tocar la base', async () => {
    const result = await resolveVehicleSnapshot(db, TENANT, {});

    expect(result).toEqual({
      vehicleTypeId: null,
      vehicleType: null,
      vehicleCategory: null,
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  describe('LPR (nombre del tipo en texto)', () => {
    it('coincide con un tipo vivo del tenant sin distinguir mayúsculas', async () => {
      findFirst.mockResolvedValue({
        id: TYPE,
        name: 'MOTOS',
        category: 'motorcycle',
      });

      const result = await resolveVehicleSnapshot(db, TENANT, {
        vehicleType: ' motos ',
      });

      expect(findFirst).toHaveBeenCalledWith({
        where: {
          tenantId: TENANT,
          deletedAt: null,
          name: { equals: 'motos', mode: 'insensitive' },
        },
        select: { id: true, name: true, category: true },
      });
      expect(result).toEqual({
        vehicleTypeId: TYPE,
        vehicleType: 'MOTOS',
        vehicleCategory: 'motorcycle',
      });
    });

    it('no coincide con ningún tipo: conserva el nombre y adivina la categoría por alias', async () => {
      findFirst.mockResolvedValue(null);

      const result = await resolveVehicleSnapshot(db, TENANT, {
        vehicleType: 'Camión',
      });

      expect(result).toEqual({
        vehicleTypeId: null,
        vehicleType: 'Camión',
        vehicleCategory: 'truck',
      });
    });

    it('un nombre irreconocible deja la categoría en null', async () => {
      findFirst.mockResolvedValue(null);

      const result = await resolveVehicleSnapshot(db, TENANT, {
        vehicleType: 'Camioneta',
      });

      expect(result.vehicleCategory).toBeNull();
      expect(result.vehicleType).toBe('Camioneta');
    });
  });
});
