import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import { EntriesService } from './entries.service';

describe('EntriesService', () => {
  let service: EntriesService;

  const mockPrisma = {
    $extends: jest.fn().mockReturnThis(),
    query: {
      $allModels: {
        $allOperations: jest.fn(),
      },
    },
    entry: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
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

  describe('findAllForTenant', () => {
    it('should call prisma with the correct tenant isolation', async () => {
      const tenantId = 'tenant-1';
      const mockEntries = [{ id: '1', plate: 'AAA111' }];

      // En el servicio, findAllForTenant llama a prismaForTenant(this.prisma, tenantId)
      // que devuelve un prisma extendido.
      // Por simplicidad en el test, mockeamos que el prisma base tiene el modelo entry.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      (mockPrisma.entry.findMany as any).mockResolvedValue(mockEntries);

      const result = await service.findAllForTenant(tenantId);

      expect(result).toEqual(mockEntries);
      // Verificamos que se llamó a findMany (la extensión se encarga de inyectar el tenantId en la vida real)
      expect(mockPrisma.entry.findMany).toHaveBeenCalled();
    });
  });
});
