import { Test } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import { VEHICLE_CATEGORY_INFO } from './vehicle-categories';
import { VehicleCategoriesService } from './vehicle-categories.service';

describe('VehicleCategoriesService', () => {
  let service: VehicleCategoriesService;
  const prisma = { vehicleCategory: { findMany: jest.fn() } };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VehicleCategoriesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(VehicleCategoriesService);
  });

  it('lista la tabla ordenada por sortOrder', async () => {
    prisma.vehicleCategory.findMany.mockResolvedValue([
      { code: 'car', label: 'Auto', sortOrder: 1, reservable: true },
      { code: 'truck', label: 'Camión', sortOrder: 7, reservable: false },
    ]);

    const result = await service.list();

    expect(prisma.vehicleCategory.findMany).toHaveBeenCalledWith({
      orderBy: { sortOrder: 'asc' },
    });
    expect(result).toEqual([
      { code: 'car', label: 'Auto', sortOrder: 1, reservable: true },
      { code: 'truck', label: 'Camión', sortOrder: 7, reservable: false },
    ]);
  });

  it('si la tabla viene vacía (deploy adelantado a la migración) cae al const', async () => {
    prisma.vehicleCategory.findMany.mockResolvedValue([]);

    const result = await service.list();

    expect(result).toEqual([...VEHICLE_CATEGORY_INFO]);
  });
});
