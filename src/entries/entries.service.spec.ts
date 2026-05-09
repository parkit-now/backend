import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import { EntriesService } from './entries.service';

describe('EntriesService', () => {
  let service: EntriesService;

  const mockTenant = {
    entry: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  };

  const mockPrisma = {
    // Simulamos el método getTenantClient
    getTenantClient: jest.fn().mockReturnValue(mockTenant),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntriesService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
      ],
    }).compile();

    service = module.get<EntriesService>(EntriesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAll', () => {
    it('should call prisma with the correct tenant isolation', async () => {
      const mockEntries = [{ id: '1', plate: 'AAA111' }];

      // Mockeamos el valor de retorno del findMany dentro de tenant
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      (mockTenant.entry.findMany as jest.Mock).mockResolvedValue(mockEntries);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const result = await service.findAll();

      expect(result).toEqual(mockEntries);
      expect(mockTenant.entry.findMany).toHaveBeenCalled();
      expect(mockPrisma.getTenantClient).toHaveBeenCalled();
    });
  });
});
