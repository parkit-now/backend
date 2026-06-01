import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { ZonesService } from './zones.service';

describe('ZonesService', () => {
  let service: ZonesService;

  const mockTenant = {
    zone: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };

  const mockPrisma = {
    getTenantClient: jest.fn().mockReturnValue(mockTenant),
  };

  const mockTenantContext = {
    getTenantIdOrThrow: jest.fn().mockReturnValue('tenant-1'),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.getTenantClient.mockReturnValue(mockTenant);
    mockTenantContext.getTenantIdOrThrow.mockReturnValue('tenant-1');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZonesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantContextService, useValue: mockTenantContext },
      ],
    }).compile();

    service = module.get<ZonesService>(ZonesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('findAll uses the tenant-scoped client', async () => {
    const rows = [{ id: 'z-1', name: 'Zone A' }];
    mockTenant.zone.findMany.mockResolvedValue(rows);

    const result = await service.findAll();

    expect(result).toEqual(rows);
    expect(mockPrisma.getTenantClient).toHaveBeenCalled();
    expect(mockTenant.zone.findMany).toHaveBeenCalled();
  });

  it('create defaults spot counts to 0 and lets the extension inject tenantId', async () => {
    mockTenant.zone.create.mockResolvedValue({ id: 'z-1' });

    await service.create({ name: 'Zone A' });

    expect(mockTenant.zone.create).toHaveBeenCalledWith({
      data: {
        name: 'Zone A',
        carSpots: 0,
        motorcycleSpots: 0,
        bicycleSpots: 0,
      },
    });
  });

  it('update scopes the where by id + tenantId', async () => {
    mockTenant.zone.findFirst.mockResolvedValue({ id: 'z-1' });
    mockTenant.zone.update.mockResolvedValue({ id: 'z-1', name: 'New' });

    await service.update('z-1', { name: 'New' });

    expect(mockTenant.zone.update).toHaveBeenCalledWith({
      where: { id: 'z-1', tenantId: 'tenant-1' },
      data: { name: 'New' },
    });
  });

  it('update throws ZONE_NOT_FOUND when the zone is not in the tenant', async () => {
    mockTenant.zone.findFirst.mockResolvedValue(null);

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(service.update('z-x', { name: 'X' })).rejects.toBeInstanceOf(
      FormattedException,
    );
    expect(mockTenant.zone.update).not.toHaveBeenCalled();
  });

  it('remove deletes scoped by tenant and returns the id', async () => {
    mockTenant.zone.findFirst.mockResolvedValue({ id: 'z-1' });
    mockTenant.zone.delete.mockResolvedValue({ id: 'z-1' });

    const result = await service.remove('z-1');

    expect(mockTenant.zone.delete).toHaveBeenCalledWith({
      where: { id: 'z-1', tenantId: 'tenant-1' },
    });
    expect(result).toEqual({ id: 'z-1' });
  });
});
